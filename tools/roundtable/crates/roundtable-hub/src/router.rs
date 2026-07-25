use crate::state::AppState;
use roundtable_protocol::{
    validate_handoff, validate_message_body, ActorKind, CreateHandoffRequest, DeliveryReason,
    PostMessageRequest, ValidationError,
};
use roundtable_store::{HandoffCommand, HandoffResult, PostMessageCommand, PostMessageResult};
use uuid::Uuid;

pub async fn post_human_message(
    state: &AppState,
    room_id: Uuid,
    request: PostMessageRequest,
    now_ms: i64,
) -> Result<PostMessageResult, RouterError> {
    validate_message_body(&request.body)?;
    Ok(state
        .store
        .post_message(PostMessageCommand {
            actor_id: state.human_actor_id,
            request_id: request.request_id,
            room_id,
            actor_kind: ActorKind::Human,
            kind: request.kind,
            body: request.body,
            reply_to: request.reply_to,
            selected_seat_ids: request.mentioned_seat_ids,
            reason: DeliveryReason::HumanMention,
            now_ms,
        })
        .await?)
}

pub async fn create_handoff(
    state: &AppState,
    room_id: Uuid,
    request: CreateHandoffRequest,
    now_ms: i64,
) -> Result<HandoffResult, RouterError> {
    validate_handoff(&request.body, &request.evidence_refs)?;
    Ok(state
        .store
        .create_handoff(HandoffCommand {
            actor_id: request.from_seat_id,
            request_id: request.request_id,
            room_id,
            from_seat_id: request.from_seat_id,
            to_seat_id: request.to_seat_id,
            body: request.body,
            evidence_refs: request.evidence_refs,
            task_key: request.task_key,
            now_ms,
        })
        .await?)
}

pub struct AgentMessageInput {
    pub node_id: Uuid,
    pub room_id: Uuid,
    pub seat_id: Uuid,
    pub request_id: Uuid,
    pub kind: roundtable_protocol::MessageKind,
    pub body: String,
    pub reply_to: Option<Uuid>,
    pub now_ms: i64,
}

pub async fn post_agent_message(
    state: &AppState,
    input: AgentMessageInput,
) -> Result<PostMessageResult, RouterError> {
    validate_message_body(&input.body)?;
    let seat = state.store.get_seat(input.seat_id).await?;
    if seat.node_id != input.node_id || seat.room_id != input.room_id {
        return Err(RouterError::SeatNotOwned);
    }
    Ok(state
        .store
        .post_message(PostMessageCommand {
            actor_id: input.seat_id,
            request_id: input.request_id,
            room_id: input.room_id,
            actor_kind: ActorKind::Agent,
            kind: input.kind,
            body: input.body,
            reply_to: input.reply_to,
            selected_seat_ids: Vec::new(),
            reason: DeliveryReason::HumanFollowup,
            now_ms: input.now_ms,
        })
        .await?)
}

#[derive(Debug, thiserror::Error)]
pub enum RouterError {
    #[error(transparent)]
    Validation(#[from] ValidationError),
    #[error(transparent)]
    Store(#[from] roundtable_store::StoreError),
    #[error("seat_not_owned")]
    SeatNotOwned,
}
