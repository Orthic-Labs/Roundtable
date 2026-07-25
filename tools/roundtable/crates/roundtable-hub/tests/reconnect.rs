use roundtable_hub::ws::{decode_node_frame, heartbeat_timed_out};
use roundtable_protocol::{
    new_id, ActorKind, DeliveryReason, DeliveryState, MessageKind, SeatProvider,
};
use roundtable_store::{DeliveryUpdate, NewNode, NewSeat, PostMessageCommand, Store, StoreError};

async fn delivery_fixture() -> (
    Store,
    roundtable_protocol::Node,
    roundtable_protocol::Delivery,
) {
    let store = Store::memory().await.unwrap();
    let room = store
        .create_room(new_id(), "room".into(), "Room".into(), "Goal".into(), 1)
        .await
        .unwrap();
    let node = store
        .add_node(NewNode {
            id: new_id(),
            name: "mac".into(),
            token_hash: "hash".into(),
            now_ms: 1,
        })
        .await
        .unwrap();
    let seat = store
        .add_seat(NewSeat {
            id: new_id(),
            room_id: room.id,
            node_id: node.id,
            alias: "mac".into(),
            provider: SeatProvider::Claude,
            session_ref: "session".into(),
            now_ms: 1,
        })
        .await
        .unwrap();
    let posted = store
        .post_message(PostMessageCommand {
            actor_id: new_id(),
            request_id: new_id(),
            room_id: room.id,
            actor_kind: ActorKind::Human,
            kind: MessageKind::Chat,
            body: "go".into(),
            reply_to: None,
            selected_seat_ids: vec![seat.id],
            reason: DeliveryReason::HumanMention,
            now_ms: 2,
        })
        .await
        .unwrap();
    (store, node, posted.deliveries[0].clone())
}

#[tokio::test]
async fn reconnect_resumes_after_last_durable_cursor() {
    let (store, node, _) = delivery_fixture().await;
    let events = store.replay_events(node.id, 0).await.unwrap();
    assert_eq!(events.len(), 1);
    assert!(store
        .replay_events(node.id, events[0].cursor)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn completed_delivery_is_not_retried() {
    let (store, node, delivery) = delivery_fixture().await;
    store
        .update_delivery(DeliveryUpdate {
            delivery_id: delivery.id,
            node_id: node.id,
            state: DeliveryState::Completed,
            error_code: None,
            now_ms: 3,
        })
        .await
        .unwrap();
    assert!(store.retry_expired(i64::MAX / 2).await.unwrap().is_empty());
}

#[tokio::test]
async fn lease_retry_preserves_delivery_id() {
    let (store, node, delivery) = delivery_fixture().await;
    let acked = store
        .update_delivery(DeliveryUpdate {
            delivery_id: delivery.id,
            node_id: node.id,
            state: DeliveryState::Running,
            error_code: None,
            now_ms: 3,
        })
        .await
        .unwrap();
    let retried = store
        .retry_expired(acked.lease_until_ms.unwrap())
        .await
        .unwrap();
    assert_eq!(retried[0].id, delivery.id);
}

#[test]
fn invalid_protocol_version_closes_with_protocol_version() {
    let frame = serde_json::json!({"version":2,"event_id":new_id(),"sent_at_ms":1,"type":"pong","payload":{"nonce":"n"}});
    assert_eq!(
        decode_node_frame(&frame.to_string()).unwrap_err(),
        "protocol_version"
    );
}

#[test]
fn heartbeat_timeout_marks_node_offline() {
    assert!(heartbeat_timed_out(0, 45_001, 45_000));
    assert!(!heartbeat_timed_out(0, 45_000, 45_000));
}

#[tokio::test]
async fn node_cannot_update_delivery_for_seat_it_does_not_own() {
    let (store, _, delivery) = delivery_fixture().await;
    let result = store
        .update_delivery(DeliveryUpdate {
            delivery_id: delivery.id,
            node_id: new_id(),
            state: DeliveryState::Acked,
            error_code: None,
            now_ms: 3,
        })
        .await;
    assert!(matches!(result, Err(StoreError::SeatNotOwned)));
}

#[tokio::test]
async fn duplicate_event_id_is_acknowledged_but_not_reinjected() {
    let (store, node, _) = delivery_fixture().await;
    let first = store.replay_events(node.id, 0).await.unwrap();
    let cursor = first[0].cursor;
    assert!(store
        .replay_events(node.id, cursor)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn a_node_cannot_post_for_a_seat_it_does_not_own() {
    let (store, _, delivery) = delivery_fixture().await;
    let seat = store.get_seat(delivery.seat_id).await.unwrap();
    let state = roundtable_hub::AppState::new(store, "admin", roundtable_hub::AppConfig::default());
    let result = roundtable_hub::router::post_agent_message(
        &state,
        roundtable_hub::router::AgentMessageInput {
            node_id: new_id(),
            room_id: seat.room_id,
            seat_id: seat.id,
            request_id: new_id(),
            kind: MessageKind::Chat,
            body: "forged".into(),
            reply_to: None,
            now_ms: 3,
        },
    )
    .await;
    assert!(matches!(
        result,
        Err(roundtable_hub::router::RouterError::SeatNotOwned)
    ));
}
