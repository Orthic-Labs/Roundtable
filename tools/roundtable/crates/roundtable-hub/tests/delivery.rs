use roundtable_hub::{router, AppConfig, AppState};
use roundtable_protocol::{
    new_id, CreateHandoffRequest, EvidenceKind, EvidenceRef, MessageKind, PostMessageRequest,
    SeatProvider,
};
use roundtable_store::{NewNode, NewSeat, Store, StoreError};

async fn fixture() -> (
    AppState,
    roundtable_protocol::Room,
    roundtable_protocol::Seat,
    roundtable_protocol::Seat,
) {
    let store = Store::memory().await.unwrap();
    let room = store
        .create_room(new_id(), "room".into(), "Room".into(), "Goal".into(), 1)
        .await
        .unwrap();
    let node_a = new_id();
    let node_b = new_id();
    for (id, name) in [(node_a, "mac"), (node_b, "windows")] {
        store
            .add_node(NewNode {
                id,
                name: name.into(),
                token_hash: name.into(),
                now_ms: 1,
            })
            .await
            .unwrap();
    }
    let seat_a = store
        .add_seat(NewSeat {
            id: new_id(),
            room_id: room.id,
            node_id: node_a,
            alias: "mac-claude".into(),
            provider: SeatProvider::Claude,
            session_ref: "a".into(),
            now_ms: 1,
        })
        .await
        .unwrap();
    let seat_b = store
        .add_seat(NewSeat {
            id: new_id(),
            room_id: room.id,
            node_id: node_b,
            alias: "windows-codex".into(),
            provider: SeatProvider::Codex,
            session_ref: "b".into(),
            now_ms: 1,
        })
        .await
        .unwrap();
    (
        AppState::new(store, "admin", AppConfig::default()),
        room,
        seat_a,
        seat_b,
    )
}

#[tokio::test]
async fn human_mention_wakes_only_selected_seats() {
    let (state, room, seat_a, seat_b) = fixture().await;
    let result = router::post_human_message(
        &state,
        room.id,
        PostMessageRequest {
            request_id: new_id(),
            kind: MessageKind::Chat,
            body: "work".into(),
            reply_to: None,
            mentioned_seat_ids: vec![seat_b.id],
        },
        2,
    )
    .await
    .unwrap();
    assert_eq!(result.deliveries.len(), 1);
    assert_eq!(result.deliveries[0].seat_id, seat_b.id);
    assert!(state
        .store
        .replay_events(seat_a.node_id, 0)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn agent_text_containing_every_alias_wakes_nobody() {
    let (state, room, seat_a, seat_b) = fixture().await;
    let result = router::post_agent_message(
        &state,
        router::AgentMessageInput {
            node_id: seat_a.node_id,
            room_id: room.id,
            seat_id: seat_a.id,
            request_id: new_id(),
            kind: MessageKind::Chat,
            body: format!("@{} @{}", seat_a.alias, seat_b.alias),
            reply_to: None,
            now_ms: 2,
        },
    )
    .await
    .unwrap();
    assert!(result.deliveries.is_empty());
    assert!(state
        .store
        .replay_events(seat_b.node_id, 0)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn structured_handoff_wakes_exactly_target_and_marks_evidence() {
    let (state, room, seat_a, seat_b) = fixture().await;
    let result = router::create_handoff(
        &state,
        room.id,
        CreateHandoffRequest {
            request_id: new_id(),
            from_seat_id: seat_a.id,
            to_seat_id: seat_b.id,
            body: "continue".into(),
            evidence_refs: vec![EvidenceRef {
                kind: EvidenceKind::CommitSha,
                value: "abc123".into(),
            }],
            task_key: Some("exclusive-fix".into()),
        },
        2,
    )
    .await
    .unwrap();
    assert_eq!(result.delivery.as_ref().unwrap().seat_id, seat_b.id);
    assert!(!result.evidence_missing);
    assert_eq!(
        state
            .store
            .replay_events(seat_b.node_id, 0)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(state
        .store
        .replay_events(seat_a.node_id, 0)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn two_seats_cannot_claim_same_exclusive_task_key() {
    let (state, room, seat_a, seat_b) = fixture().await;
    let first = CreateHandoffRequest {
        request_id: new_id(),
        from_seat_id: seat_a.id,
        to_seat_id: seat_b.id,
        body: "first".into(),
        evidence_refs: vec![],
        task_key: Some("task".into()),
    };
    router::create_handoff(&state, room.id, first, 2)
        .await
        .unwrap();
    let second = CreateHandoffRequest {
        request_id: new_id(),
        from_seat_id: seat_b.id,
        to_seat_id: seat_a.id,
        body: "second".into(),
        evidence_refs: vec![],
        task_key: Some("task".into()),
    };
    let error = router::create_handoff(&state, room.id, second, 3)
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        router::RouterError::Store(StoreError::TaskKeyClaimed)
    ));
}

#[tokio::test]
async fn circular_handoffs_stop_after_depth_eight() {
    let (state, room, seat_a, seat_b) = fixture().await;
    let mut from = seat_a.id;
    let mut to = seat_b.id;
    for depth in 1..=9 {
        let result = router::create_handoff(
            &state,
            room.id,
            CreateHandoffRequest {
                request_id: new_id(),
                from_seat_id: from,
                to_seat_id: to,
                body: format!("step {depth}"),
                evidence_refs: vec![],
                task_key: None,
            },
            depth,
        )
        .await
        .unwrap();
        if depth <= 8 {
            assert!(result.delivery.is_some());
        } else {
            assert_eq!(result.error_code.as_deref(), Some("handoff_depth_exceeded"));
            assert!(result.delivery.is_none());
        }
        std::mem::swap(&mut from, &mut to);
    }
}

#[tokio::test]
async fn handoff_to_offline_seat_remains_queued() {
    let (state, room, seat_a, seat_b) = fixture().await;
    let result = router::create_handoff(
        &state,
        room.id,
        CreateHandoffRequest {
            request_id: new_id(),
            from_seat_id: seat_a.id,
            to_seat_id: seat_b.id,
            body: "queued while offline".into(),
            evidence_refs: vec![],
            task_key: None,
        },
        2,
    )
    .await
    .unwrap();
    assert_eq!(
        result.delivery.unwrap().state,
        roundtable_protocol::DeliveryState::Queued
    );
}

#[tokio::test]
async fn completion_without_evidence_refs_is_marked_evidence_missing() {
    let (state, room, seat_a, _) = fixture().await;
    let result = router::post_agent_message(
        &state,
        router::AgentMessageInput {
            node_id: seat_a.node_id,
            room_id: room.id,
            seat_id: seat_a.id,
            request_id: new_id(),
            kind: MessageKind::Completion,
            body: "done".into(),
            reply_to: None,
            now_ms: 2,
        },
    )
    .await
    .unwrap();
    assert!(result.evidence_missing);
    let messages = state
        .store
        .list_messages(room.id, None, None, 100)
        .await
        .unwrap();
    assert!(messages
        .iter()
        .any(|message| message.body == "evidence_missing"));
}

#[tokio::test]
async fn messages_older_than_seat_cursor_are_readable_but_not_reinjected() {
    use roundtable_store::DeliveryUpdate;
    let (state, room, _, seat_b) = fixture().await;
    let first = router::post_human_message(
        &state,
        room.id,
        PostMessageRequest {
            request_id: new_id(),
            kind: MessageKind::Chat,
            body: "old".into(),
            reply_to: None,
            mentioned_seat_ids: vec![seat_b.id],
        },
        2,
    )
    .await
    .unwrap();
    state
        .store
        .update_delivery(DeliveryUpdate {
            delivery_id: first.deliveries[0].id,
            node_id: seat_b.node_id,
            state: roundtable_protocol::DeliveryState::Completed,
            error_code: None,
            now_ms: 3,
        })
        .await
        .unwrap();
    router::post_human_message(
        &state,
        room.id,
        PostMessageRequest {
            request_id: new_id(),
            kind: MessageKind::Chat,
            body: "new".into(),
            reply_to: None,
            mentioned_seat_ids: vec![seat_b.id],
        },
        4,
    )
    .await
    .unwrap();
    let events = state.store.replay_events(seat_b.node_id, 0).await.unwrap();
    let context = events.last().unwrap().payload["context_messages"]
        .as_array()
        .unwrap();
    assert!(!context.iter().any(|message| message["body"] == "old"));
    assert!(state
        .store
        .list_messages(room.id, None, None, 100)
        .await
        .unwrap()
        .iter()
        .any(|message| message.body == "old"));
}

#[tokio::test]
async fn approval_request_and_resolution_are_durable_and_targeted() {
    use roundtable_store::{NewApproval, ResolveApproval};
    let (state, room, _, seat_b) = fixture().await;
    let posted = router::post_human_message(
        &state,
        room.id,
        PostMessageRequest {
            request_id: new_id(),
            kind: MessageKind::Chat,
            body: "needs approval".into(),
            reply_to: None,
            mentioned_seat_ids: vec![seat_b.id],
        },
        2,
    )
    .await
    .unwrap();
    let approval = state
        .store
        .create_approval(NewApproval {
            request_id: new_id(),
            node_id: seat_b.node_id,
            seat_id: seat_b.id,
            delivery_id: posted.deliveries[0].id,
            provider_request_id: "provider-1".into(),
            description: "run command".into(),
            input_preview: "cargo test".into(),
            decisions: vec!["allow".into(), "deny".into()],
            now_ms: 3,
        })
        .await
        .unwrap();
    let resolved = state
        .store
        .resolve_approval(ResolveApproval {
            actor_id: state.human_actor_id,
            request_id: new_id(),
            approval_id: approval.id,
            decision: "allow".into(),
            now_ms: 4,
        })
        .await
        .unwrap();
    assert_eq!(resolved.resolution.as_deref(), Some("allow"));
    let events = state.store.replay_events(seat_b.node_id, 0).await.unwrap();
    assert!(events
        .iter()
        .any(|event| event.event_type == "approval.resolve"));
}
