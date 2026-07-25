use crate::auth::{
    bearer_from_headers, clear_session_cookie, hash_secret, random_token, session_cookie,
    session_from_headers, token_matches,
};
use crate::router;
use crate::state::AppState;
use crate::ws;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use roundtable_protocol::{
    new_id, validate_alias, validate_message_body, validate_room, CreateHandoffRequest,
    CreateNodeRequest, CreateRoomRequest, CreateSeatRequest, LoginRequest, PostMessageRequest,
    ResolveApprovalRequest, UpdateRoomRequest,
};
use roundtable_store::{
    now_ms, CreateRoomMutation, NewNode, NewSeat, ResolveApproval as StoreResolveApproval,
    StoreError,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/readyz", get(ready))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/rooms", get(list_rooms).post(create_room))
        .route("/api/rooms/{room_id}", get(get_room).patch(update_room))
        .route(
            "/api/rooms/{room_id}/messages",
            get(list_messages).post(post_message),
        )
        .route(
            "/api/rooms/{room_id}/seats",
            get(list_seats).post(create_seat),
        )
        .route("/api/rooms/{room_id}/seats/{seat_id}", delete(delete_seat))
        .route("/api/rooms/{room_id}/handoffs", post(create_handoff))
        .route(
            "/api/approvals/{approval_id}/resolve",
            post(resolve_approval),
        )
        .route("/api/nodes", get(list_nodes).post(create_node))
        .route("/api/nodes/{node_id}", delete(delete_node))
        .route("/api/events", get(ws::browser_events))
        .route("/node/connect", get(ws::node_connect))
        .layer(DefaultBodyLimit::max(
            roundtable_protocol::MESSAGE_BODY_MAX_BYTES + 16 * 1024,
        ))
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}

async fn security_headers(request: axum::extract::Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'self'; connect-src 'self' wss://roundtable.spoares.com; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

async fn health() -> StatusCode {
    StatusCode::OK
}

async fn ready(State(state): State<AppState>) -> Result<StatusCode, ApiError> {
    state.store.list_rooms().await?;
    Ok(StatusCode::OK)
}

async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<LoginRequest>,
) -> Result<Response, ApiError> {
    require_origin(&state, &headers)?;
    if !token_matches(&state.admin_token_hash, &request.token) {
        return Err(ApiError::Unauthorized);
    }
    let token = random_token();
    let now = now_ms();
    state
        .store
        .put_browser_session(hash_secret(&token), now + state.config.session_ttl_ms, now)
        .await?;
    let cookie = session_cookie(
        &token,
        state.config.secure_cookie,
        state.config.session_ttl_ms / 1_000,
    );
    let mut response = Json(json!({"authenticated": true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|_| ApiError::Internal)?,
    );
    Ok(response)
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    require_origin(&state, &headers)?;
    require_session(&state, &headers).await?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&clear_session_cookie(state.config.secure_cookie))
            .map_err(|_| ApiError::Internal)?,
    );
    Ok(response)
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    require_session(&state, &headers).await?;
    Ok(Json(json!({"authenticated": true})))
}

async fn list_rooms(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_session(&state, &headers).await?;
    Ok(Json(json!({"rooms": state.store.list_rooms().await?})))
}

async fn create_room(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateRoomRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    require_mutation(&state, &headers).await?;
    validate_room(&request.slug, &request.title, &request.objective)
        .map_err(ApiError::validation)?;
    let room = state
        .store
        .create_room_dedup(CreateRoomMutation {
            actor_id: state.human_actor_id,
            request_id: request.request_id,
            id: new_id(),
            slug: request.slug,
            title: request.title,
            objective: request.objective,
            now_ms: now_ms(),
        })
        .await?;
    Ok((StatusCode::CREATED, Json(json!({"room": room}))))
}

async fn get_room(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(room_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    require_session(&state, &headers).await?;
    let room = state.store.get_room(room_id).await?;
    let seats = state.store.list_seats(room_id).await?;
    Ok(Json(json!({"room": room, "seats": seats})))
}

async fn update_room(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(room_id): Path<Uuid>,
    Json(request): Json<UpdateRoomRequest>,
) -> Result<Json<Value>, ApiError> {
    require_mutation(&state, &headers).await?;
    let current = state.store.get_room(room_id).await?;
    validate_room(
        &current.slug,
        request.title.as_deref().unwrap_or(&current.title),
        request.objective.as_deref().unwrap_or(&current.objective),
    )
    .map_err(ApiError::validation)?;
    let room = state
        .store
        .update_room(
            room_id,
            request.title,
            request.objective,
            request.archived,
            now_ms(),
        )
        .await?;
    Ok(Json(json!({"room": room})))
}

#[derive(Debug, Deserialize)]
struct MessageQuery {
    after_seq: Option<i64>,
    before_seq: Option<i64>,
    limit: Option<u16>,
}

async fn list_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(room_id): Path<Uuid>,
    Query(query): Query<MessageQuery>,
) -> Result<Json<Value>, ApiError> {
    require_session(&state, &headers).await?;
    let limit = query.limit.unwrap_or(100);
    if limit == 0 || limit > roundtable_protocol::PAGE_LIMIT_MAX {
        return Err(ApiError::Unprocessable("page_limit".into()));
    }
    let messages = state
        .store
        .list_messages(room_id, query.after_seq, query.before_seq, limit)
        .await?;
    Ok(Json(json!({"messages": messages})))
}

async fn post_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(room_id): Path<Uuid>,
    Json(request): Json<PostMessageRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    require_mutation(&state, &headers).await?;
    validate_message_body(&request.body).map_err(ApiError::validation)?;
    let result = router::post_human_message(&state, room_id, request, now_ms()).await?;
    Ok((StatusCode::CREATED, Json(json!(result))))
}

async fn list_seats(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(room_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    require_session(&state, &headers).await?;
    Ok(Json(
        json!({"seats": state.store.list_seats(room_id).await?}),
    ))
}

async fn create_seat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(room_id): Path<Uuid>,
    Json(request): Json<CreateSeatRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    require_mutation(&state, &headers).await?;
    validate_alias(&request.alias).map_err(ApiError::validation)?;
    let seat = state
        .store
        .add_seat(NewSeat {
            id: new_id(),
            room_id,
            node_id: request.node_id,
            alias: request.alias,
            provider: request.provider,
            session_ref: request.session_ref,
            now_ms: now_ms(),
        })
        .await?;
    Ok((StatusCode::CREATED, Json(json!({"seat": seat}))))
}

async fn delete_seat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((room_id, seat_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    require_mutation(&state, &headers).await?;
    state.store.delete_seat(room_id, seat_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn create_handoff(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(room_id): Path<Uuid>,
    Json(request): Json<CreateHandoffRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    require_mutation(&state, &headers).await?;
    let result = router::create_handoff(&state, room_id, request, now_ms()).await?;
    Ok((StatusCode::CREATED, Json(json!(result))))
}

async fn resolve_approval(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(approval_id): Path<Uuid>,
    Json(request): Json<ResolveApprovalRequest>,
) -> Result<Json<Value>, ApiError> {
    require_mutation(&state, &headers).await?;
    let approval = state
        .store
        .resolve_approval(StoreResolveApproval {
            actor_id: state.human_actor_id,
            request_id: request.request_id,
            approval_id,
            decision: request.decision,
            now_ms: now_ms(),
        })
        .await?;
    Ok(Json(json!({"approval": approval})))
}

async fn list_nodes(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_session(&state, &headers).await?;
    Ok(Json(json!({"nodes": state.store.list_nodes().await?})))
}

async fn create_node(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateNodeRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    require_mutation(&state, &headers).await?;
    if request.name.is_empty() || request.name.len() > 80 {
        return Err(ApiError::Unprocessable("invalid_node_name".into()));
    }
    let token = random_token();
    let node = state
        .store
        .add_node(NewNode {
            id: new_id(),
            name: request.name,
            token_hash: hash_secret(&token),
            now_ms: now_ms(),
        })
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"node": node, "token": token})),
    ))
}

async fn delete_node(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(node_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    require_mutation(&state, &headers).await?;
    state.store.revoke_node(node_id, now_ms()).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn require_session(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let token = session_from_headers(headers).ok_or(ApiError::Unauthorized)?;
    if state
        .store
        .browser_session_valid(hash_secret(token), now_ms())
        .await?
    {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

pub fn require_origin(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    if origin == Some(state.config.origin.as_str()) {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}

async fn require_mutation(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    require_origin(state, headers)?;
    require_session(state, headers).await
}

pub async fn authenticate_node_headers(
    state: &AppState,
    headers: &HeaderMap,
    node_id: Uuid,
) -> Result<(), ApiError> {
    let token = bearer_from_headers(headers).ok_or(ApiError::Unauthorized)?;
    if state
        .store
        .authenticate_node(node_id, hash_secret(token), now_ms())
        .await?
    {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

#[derive(Debug)]
pub enum ApiError {
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict(String),
    PayloadTooLarge,
    Unprocessable(String),
    Internal,
}

impl ApiError {
    fn validation(error: roundtable_protocol::ValidationError) -> Self {
        match error {
            roundtable_protocol::ValidationError::MessageTooLarge => Self::PayloadTooLarge,
            other => Self::Unprocessable(other.to_string()),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_owned()),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden".to_owned()),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found".to_owned()),
            Self::Conflict(code) => (StatusCode::CONFLICT, code),
            Self::PayloadTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "message_too_large".to_owned(),
            ),
            Self::Unprocessable(code) => (StatusCode::UNPROCESSABLE_ENTITY, code),
            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal".to_owned()),
        };
        (status, Json(json!({"error": code}))).into_response()
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::NotFound => Self::NotFound,
            StoreError::RequestIdReused => Self::Conflict("request_id_reused".into()),
            StoreError::TaskKeyClaimed => Self::Conflict("task_key_claimed".into()),
            StoreError::SeatNotOwned => Self::Forbidden,
            StoreError::Sqlite(_) => Self::Conflict("constraint".into()),
            _ => Self::Internal,
        }
    }
}

impl From<router::RouterError> for ApiError {
    fn from(error: router::RouterError) -> Self {
        match error {
            router::RouterError::Validation(error) => Self::validation(error),
            router::RouterError::Store(error) => error.into(),
            router::RouterError::SeatNotOwned => Self::Forbidden,
        }
    }
}
