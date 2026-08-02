use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use citadel_hub::{app, auth::hash_secret, AppConfig, AppState};
use citadel_protocol::new_id;
use citadel_store::{NewNode, Store};
use tower::ServiceExt;

async fn state() -> AppState {
    AppState::new(
        Store::memory().await.unwrap(),
        "admin-secret",
        AppConfig::default(),
    )
}

fn login_request(token: &str, origin: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, origin)
        .body(Body::from(
            serde_json::json!({"request_id":new_id(),"token":token}).to_string(),
        ))
        .unwrap()
}

#[tokio::test]
async fn invalid_login_returns_401_without_cookie() {
    let response = app(state().await)
        .oneshot(login_request("wrong", "https://roundtable.spoares.com"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(response.headers().get(header::SET_COOKIE).is_none());
}

#[tokio::test]
async fn valid_login_sets_exact_cookie_attributes() {
    let response = app(state().await)
        .oneshot(login_request(
            "admin-secret",
            "https://roundtable.spoares.com",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(cookie.starts_with("__Host-roundtable="));
    assert!(cookie.ends_with("; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure"));
}

#[tokio::test]
async fn wrong_origin_returns_403_on_mutations() {
    let response = app(state().await)
        .oneshot(login_request("admin-secret", "https://evil.invalid"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn revoked_node_token_cannot_upgrade() {
    use axum::response::IntoResponse;
    use citadel_hub::http::authenticate_node_headers;

    let state = state().await;
    let node_id = new_id();
    state
        .store
        .add_node(NewNode {
            id: node_id,
            name: "mac".into(),
            token_hash: hash_secret("node-secret"),
            now_ms: 1,
        })
        .await
        .unwrap();
    state.store.revoke_node(node_id, 2).await.unwrap();
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(header::AUTHORIZATION, "Bearer node-secret".parse().unwrap());
    let error = authenticate_node_headers(&state, &headers, node_id)
        .await
        .unwrap_err();
    assert_eq!(error.into_response().status(), StatusCode::UNAUTHORIZED);
}
