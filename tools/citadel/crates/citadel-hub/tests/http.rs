use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use citadel_hub::{app, AppConfig, AppState};
use citadel_protocol::new_id;
use citadel_store::Store;
use serde_json::{json, Value};
use tower::ServiceExt;

const ORIGIN: &str = "https://citadel.spoares.com";

async fn fixture() -> (AppState, String) {
    let state = AppState::new(
        Store::memory().await.unwrap(),
        "admin",
        AppConfig::default(),
    );
    let response = app(state.clone())
        .oneshot(json_request(
            "POST",
            "/api/auth/login",
            None,
            json!({"request_id":new_id(),"token":"admin"}),
        ))
        .await
        .unwrap();
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    (state, cookie)
}

fn json_request(method: &str, uri: &str, cookie: Option<&str>, value: Value) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, ORIGIN);
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    builder.body(Body::from(value.to_string())).unwrap()
}

async fn body_json(response: axum::response::Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[tokio::test]
async fn unauthenticated_transcript_access_returns_401() {
    let (state, _) = fixture().await;
    let response = app(state)
        .oneshot(
            Request::builder()
                .uri(format!("/api/rooms/{}/messages", new_id()))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn room_and_message_crud_validate_limits() {
    let (state, cookie) = fixture().await;
    let response = app(state.clone())
        .oneshot(json_request(
            "POST",
            "/api/rooms",
            Some(&cookie),
            json!({"request_id":new_id(),"slug":"alpha","title":"Alpha","objective":"Ship"}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let room_id = body_json(response).await["room"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let response = app(state)
        .oneshot(json_request(
            "POST",
            &format!("/api/rooms/{room_id}/messages"),
            Some(&cookie),
            json!({"request_id":new_id(),"kind":"chat","body":"x".repeat(65537),"reply_to":null,"mentioned_seat_ids":[]}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn duplicate_mutation_returns_first_response() {
    let (state, cookie) = fixture().await;
    let room = state
        .store
        .create_room(new_id(), "dedupe".into(), "Dedupe".into(), "Goal".into(), 1)
        .await
        .unwrap();
    let request_id = new_id();
    let payload = json!({"request_id":request_id,"kind":"chat","body":"once","reply_to":null,"mentioned_seat_ids":[]});
    let first = app(state.clone())
        .oneshot(json_request(
            "POST",
            &format!("/api/rooms/{}/messages", room.id),
            Some(&cookie),
            payload.clone(),
        ))
        .await
        .unwrap();
    let second = app(state)
        .oneshot(json_request(
            "POST",
            &format!("/api/rooms/{}/messages", room.id),
            Some(&cookie),
            payload,
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::CREATED);
    assert_eq!(second.status(), StatusCode::CREATED);
    assert_eq!(body_json(first).await, body_json(second).await);
}
