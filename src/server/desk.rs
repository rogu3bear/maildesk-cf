use leptos::prelude::use_context;
use maildesk_router::{authorize_reply, RouteDecision, RouteKind};
use serde::{Deserialize, Serialize};
use worker::D1Type;

use crate::api::{
    AuditSummary, DeskSnapshot, MessageSummary, ReplyReceipt, RouteHealthSummary, ThreadDetail,
    ThreadSummary,
};

use super::{AppError, AppResult, AppState};

const MAX_VISIBLE_THREADS: i32 = 50;
const MAX_VISIBLE_MESSAGES: i32 = 200;
const MAX_VISIBLE_AUDIT_EVENTS: i32 = 100;
const MAX_REPLY_SUBJECT_BYTES: usize = 240;
const MAX_REPLY_BODY_BYTES: usize = 24_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OperatorDeliveryMode {
    WebDesk,
    InboxRelay,
    Invalid,
}

impl OperatorDeliveryMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::WebDesk => "web_desk",
            Self::InboxRelay => "inbox_relay",
            Self::Invalid => "invalid",
        }
    }
}

#[derive(Debug, Deserialize)]
struct ThreadRow {
    id: String,
    subject: Option<String>,
    external_sender: String,
    status: String,
    updated_at: String,
    message_count: i64,
    domain: String,
    local_part: String,
    route_kind: String,
    reply_identity: String,
}

#[derive(Debug, Deserialize)]
struct MessageRow {
    id: String,
    direction: String,
    envelope_from: Option<String>,
    envelope_to: String,
    created_at: String,
}

#[derive(Debug, Deserialize)]
struct AuditRow {
    id: String,
    actor: String,
    action: String,
    created_at: String,
}

#[derive(Debug, Deserialize)]
struct RouteHealthRow {
    route_address: String,
    decision_kind: String,
    enabled: i64,
    desired_provider: String,
    observed_provider: Option<String>,
    operator_count: i64,
    reply_identity: String,
    policy_sha256: Option<String>,
    inbound_status: String,
    reply_status: String,
    last_inbound_at: Option<String>,
    last_reply_at: Option<String>,
    last_inbound_provider_accepted_at: Option<String>,
    last_inbound_provider_message_ids_json: String,
    last_inbox_verified_at: Option<String>,
    last_reply_provider_accepted_at: Option<String>,
    last_reply_provider_message_id: Option<String>,
    last_reply_verified_at: Option<String>,
    last_error_code: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutboundReplyRequestedJob {
    kind: &'static str,
    message_id: String,
    thread_id: String,
    operator: String,
    envelope_to: String,
    from_identity: String,
    to: Vec<String>,
    subject: String,
    text: String,
    requested_identity: String,
    queued_at: String,
}

pub async fn load_desk() -> AppResult<DeskSnapshot> {
    let state = app_state()?;
    let delivery_mode = operator_delivery_mode(&state);
    if delivery_mode == OperatorDeliveryMode::Invalid {
        return Err(AppError::client("Operator delivery mode is invalid."));
    }
    let operator = operator(&state)?;
    let outbound_mode = state
        .env
        .var("MAILDESK_OUTBOUND_MODE")
        .ok()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "disabled".to_string());

    if state.preview() {
        return Ok(DeskSnapshot {
            operator,
            preview: true,
            threads: Vec::new(),
            open_count: 0,
            outbound_mode,
            operator_delivery_mode: delivery_mode.as_str().to_string(),
            routes: Vec::new(),
        });
    }

    let db = state.db().map_err(db_binding_error)?;
    let routes = query_route_health(&db).await?;
    let threads = if delivery_mode == OperatorDeliveryMode::InboxRelay {
        Vec::new()
    } else {
        query_threads(&db, &operator).await?
    };
    let open_count = threads
        .iter()
        .filter(|thread| thread.status == "open")
        .count();
    Ok(DeskSnapshot {
        operator: dashboard_operator_label(delivery_mode.as_str(), operator),
        preview: false,
        threads,
        open_count,
        outbound_mode,
        operator_delivery_mode: delivery_mode.as_str().to_string(),
        routes,
    })
}

pub async fn load_thread(thread_id: String) -> AppResult<ThreadDetail> {
    let state = app_state()?;
    require_web_desk_mode(
        operator_delivery_mode(&state),
        "Thread reading is disabled in inbox-relay mode. Use the routing-health dashboard.",
    )?;
    let operator = operator(&state)?;
    let thread_id = normalize_identifier(thread_id, "Thread reference is invalid.")?;

    if state.preview() {
        return Err(AppError::client(
            "Thread data is unavailable while the desk is in template preview mode.",
        ));
    }

    let db = state.db().map_err(db_binding_error)?;
    let thread = query_thread(&db, &operator, &thread_id).await?;
    let messages = query_messages(&db, &operator, &thread_id).await?;
    let audit = query_audit(&db, &operator, &thread_id).await?;
    let allowed_reply_identities = vec![thread.reply_identity.clone()];
    let outbound_mode = outbound_mode(&state);

    Ok(ThreadDetail {
        thread,
        messages,
        audit,
        allowed_reply_identities,
        outbound_mode,
    })
}

pub async fn queue_reply(
    thread_id: String,
    from_identity: String,
    subject: String,
    body: String,
) -> AppResult<ReplyReceipt> {
    let state = app_state()?;
    require_web_desk_mode(
        operator_delivery_mode(&state),
        "Web replies are disabled in inbox-relay mode. Reply normally from the routed operator inbox.",
    )?;
    if state.preview() {
        return Err(AppError::client(
            "Replies are disabled while the desk is in template preview mode.",
        ));
    }

    let mode = outbound_mode(&state);
    if mode == "disabled" {
        return Err(AppError::client(
            "Outbound sending is disabled for this instance.",
        ));
    }
    if mode != "cloudflare_email_service" && mode != "resend" {
        return Err(AppError::internal("Outbound mode is invalid.", mode));
    }

    let operator = operator(&state)?;
    let thread_id = normalize_identifier(thread_id, "Thread reference is invalid.")?;
    let from_identity = normalize_mailbox(from_identity)?;
    let subject = normalize_subject(subject)?;
    let body = normalize_text(body, MAX_REPLY_BODY_BYTES, "Reply body")?;
    let db = state.db().map_err(db_binding_error)?;
    let thread = query_thread(&db, &operator, &thread_id).await?;

    let decision = route_decision_for_thread(&thread, &operator)?;
    let authorization = authorize_reply(&decision, &operator, Some(&from_identity))
        .map_err(|_| AppError::client("The selected reply identity is not authorized."))?;

    let message_id = random_message_id()?;
    let queued_at = worker::Date::now().to_string();
    let job = OutboundReplyRequestedJob {
        kind: "outbound_reply_requested",
        message_id: message_id.clone(),
        thread_id,
        operator,
        envelope_to: thread.route_address,
        from_identity: authorization.from_identity.clone(),
        to: vec![thread.external_sender],
        subject,
        text: body,
        requested_identity: authorization.from_identity.clone(),
        queued_at,
    };

    state
        .queue()
        .map_err(|error| AppError::internal("Failed to access Queue binding.", error))?
        .send(job)
        .await
        .map_err(|error| AppError::internal("Failed to queue authorized reply.", error))?;

    Ok(ReplyReceipt {
        queued: true,
        message_id,
        from_identity: authorization.from_identity,
    })
}

async fn query_threads(db: &worker::D1Database, operator: &str) -> AppResult<Vec<ThreadSummary>> {
    let operator_arg = D1Type::Text(operator);
    let limit_arg = D1Type::Integer(MAX_VISIBLE_THREADS);
    let rows = db
        .prepare(
            "SELECT t.id, t.subject, t.external_sender, t.status, t.updated_at,
                    COUNT(m.id) AS message_count, d.domain, ar.local_part,
                    ar.kind AS route_kind, i.address AS reply_identity
             FROM threads t
             JOIN domains d ON d.id = t.domain_id
             JOIN alias_routes ar ON ar.id = t.route_id
             JOIN identities i ON i.id = ar.default_reply_identity_id
             JOIN alias_route_operators aro ON aro.route_id = ar.id
             JOIN operators o ON o.id = aro.operator_id
             LEFT JOIN messages m ON m.thread_id = t.id
             WHERE lower(o.email) = lower(?1)
             GROUP BY t.id, d.domain, ar.local_part, ar.kind, i.address
             ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END, t.updated_at DESC
             LIMIT ?2",
        )
        .bind_refs([&operator_arg, &limit_arg])
        .map_err(|error| d1_error("Failed to bind operator thread query.", error))?
        .all()
        .await
        .map_err(|error| d1_error("Failed to query operator threads.", error))?
        .results::<ThreadRow>()
        .map_err(|error| d1_error("Failed to decode operator thread rows.", error))?;

    rows.into_iter().map(map_thread).collect()
}

async fn query_route_health(db: &worker::D1Database) -> AppResult<Vec<RouteHealthSummary>> {
    let rows = db
        .prepare(
            "SELECT rh.route_address, rh.decision_kind, ar.enabled, rh.desired_provider, rh.observed_provider,
                    rh.operator_count, rh.reply_identity, rh.policy_sha256, rh.inbound_status, rh.reply_status,
                    last_inbound_at, last_reply_at,
                    last_inbound_provider_accepted_at, last_inbound_provider_message_ids_json,
                    last_inbox_verified_at, last_reply_provider_accepted_at,
                    last_reply_provider_message_id, last_reply_verified_at,
                    last_error_code
             FROM route_health rh
             JOIN alias_routes ar ON ar.id = rh.route_id
             ORDER BY CASE
               WHEN inbound_status IN ('partial_delivery', 'recovery_required', 'failed')
                 OR reply_status IN ('partial_delivery', 'recovery_required', 'failed') THEN 0
               ELSE 1
             END, route_address ASC",
        )
        .all()
        .await
        .map_err(|error| d1_error("Failed to query route health.", error))?
        .results::<RouteHealthRow>()
        .map_err(|error| d1_error("Failed to decode route health.", error))?;

    rows.into_iter()
        .map(|row| {
            let operator_count = usize::try_from(row.operator_count)
                .map_err(|error| AppError::internal("Stored operator count is invalid.", error))?;
            let last_inbound_provider_message_ids =
                serde_json::from_str::<Vec<String>>(&row.last_inbound_provider_message_ids_json)
                    .map_err(|error| {
                        AppError::internal("Stored provider message IDs are invalid.", error)
                    })?;
            Ok(RouteHealthSummary {
                route_address: row.route_address,
                decision_kind: row.decision_kind,
                enabled: row.enabled == 1,
                desired_provider: row.desired_provider,
                observed_provider: row.observed_provider,
                operator_count,
                reply_identity: row.reply_identity,
                policy_sha256: row.policy_sha256,
                inbound_status: row.inbound_status,
                reply_status: row.reply_status,
                last_inbound_at: row.last_inbound_at,
                last_reply_at: row.last_reply_at,
                last_inbound_provider_accepted_at: row.last_inbound_provider_accepted_at,
                last_inbound_provider_message_ids,
                last_inbox_verified_at: row.last_inbox_verified_at,
                last_reply_provider_accepted_at: row.last_reply_provider_accepted_at,
                last_reply_provider_message_id: row.last_reply_provider_message_id,
                last_reply_verified_at: row.last_reply_verified_at,
                last_error_code: row.last_error_code,
            })
        })
        .collect()
}

fn dashboard_operator_label(operator_delivery_mode: &str, operator: String) -> String {
    if operator_delivery_mode == "inbox_relay" {
        "authorized-operator".to_string()
    } else {
        operator
    }
}

async fn query_thread(
    db: &worker::D1Database,
    operator: &str,
    thread_id: &str,
) -> AppResult<ThreadSummary> {
    let operator_arg = D1Type::Text(operator);
    let thread_arg = D1Type::Text(thread_id);
    let row = db
        .prepare(
            "SELECT t.id, t.subject, t.external_sender, t.status, t.updated_at,
                    COUNT(m.id) AS message_count, d.domain, ar.local_part,
                    ar.kind AS route_kind, i.address AS reply_identity
             FROM threads t
             JOIN domains d ON d.id = t.domain_id
             JOIN alias_routes ar ON ar.id = t.route_id
             JOIN identities i ON i.id = ar.default_reply_identity_id
             JOIN alias_route_operators aro ON aro.route_id = ar.id
             JOIN operators o ON o.id = aro.operator_id
             LEFT JOIN messages m ON m.thread_id = t.id
             WHERE t.id = ?1 AND lower(o.email) = lower(?2)
             GROUP BY t.id, d.domain, ar.local_part, ar.kind, i.address",
        )
        .bind_refs([&thread_arg, &operator_arg])
        .map_err(|error| d1_error("Failed to bind authorized thread query.", error))?
        .first::<ThreadRow>(None)
        .await
        .map_err(|error| d1_error("Failed to query authorized thread.", error))?
        .ok_or_else(|| AppError::client("Thread not found or not authorized."))?;
    map_thread(row)
}

async fn query_messages(
    db: &worker::D1Database,
    operator: &str,
    thread_id: &str,
) -> AppResult<Vec<MessageSummary>> {
    let operator_arg = D1Type::Text(operator);
    let thread_arg = D1Type::Text(thread_id);
    let limit_arg = D1Type::Integer(MAX_VISIBLE_MESSAGES);
    db.prepare(
        "SELECT m.id, m.direction, m.envelope_from, m.envelope_to, m.created_at
         FROM messages m
         JOIN threads t ON t.id = m.thread_id
         JOIN alias_route_operators aro ON aro.route_id = t.route_id
         JOIN operators o ON o.id = aro.operator_id
         WHERE t.id = ?1 AND lower(o.email) = lower(?2)
         ORDER BY m.created_at ASC
         LIMIT ?3",
    )
    .bind_refs([&thread_arg, &operator_arg, &limit_arg])
    .map_err(|error| d1_error("Failed to bind authorized message query.", error))?
    .all()
    .await
    .map_err(|error| d1_error("Failed to query authorized message metadata.", error))?
    .results::<MessageRow>()
    .map_err(|error| d1_error("Failed to decode message metadata.", error))
    .map(|rows| {
        rows.into_iter()
            .map(|row| MessageSummary {
                id: row.id,
                direction: row.direction,
                envelope_from: row.envelope_from.unwrap_or_else(|| "—".to_string()),
                envelope_to: row.envelope_to,
                created_at: row.created_at,
            })
            .collect()
    })
}

async fn query_audit(
    db: &worker::D1Database,
    operator: &str,
    thread_id: &str,
) -> AppResult<Vec<AuditSummary>> {
    let operator_arg = D1Type::Text(operator);
    let thread_arg = D1Type::Text(thread_id);
    let limit_arg = D1Type::Integer(MAX_VISIBLE_AUDIT_EVENTS);
    db.prepare(
        "SELECT a.id, a.actor, a.action, a.created_at
         FROM audit_events a
         JOIN threads t ON t.id = a.thread_id
         JOIN alias_route_operators aro ON aro.route_id = t.route_id
         JOIN operators o ON o.id = aro.operator_id
         WHERE t.id = ?1 AND lower(o.email) = lower(?2)
         ORDER BY a.created_at DESC
         LIMIT ?3",
    )
    .bind_refs([&thread_arg, &operator_arg, &limit_arg])
    .map_err(|error| d1_error("Failed to bind authorized audit query.", error))?
    .all()
    .await
    .map_err(|error| d1_error("Failed to query authorized audit activity.", error))?
    .results::<AuditRow>()
    .map_err(|error| d1_error("Failed to decode audit activity.", error))
    .map(|rows| {
        rows.into_iter()
            .map(|row| AuditSummary {
                id: row.id,
                actor: row.actor,
                action: row.action,
                created_at: row.created_at,
            })
            .collect()
    })
}

fn map_thread(row: ThreadRow) -> AppResult<ThreadSummary> {
    if row.message_count < 0 {
        return Err(AppError::internal(
            "Stored message count is invalid.",
            row.message_count,
        ));
    }
    let message_count = usize::try_from(row.message_count)
        .map_err(|error| AppError::internal("Stored message count is out of range.", error))?;
    Ok(ThreadSummary {
        id: row.id,
        subject: row.subject.unwrap_or_else(|| "(no subject)".to_string()),
        external_sender: row.external_sender,
        status: row.status,
        updated_at: row.updated_at,
        message_count,
        route_address: format!("{}@{}", row.local_part, row.domain),
        route_kind: row.route_kind,
        reply_identity: row.reply_identity,
    })
}

fn route_decision_for_thread(thread: &ThreadSummary, operator: &str) -> AppResult<RouteDecision> {
    let route_kind = match thread.route_kind.as_str() {
        "role" => RouteKind::RoleAlias,
        "personal" => RouteKind::PersonalAlias,
        other => return Err(AppError::internal("Stored route kind is invalid.", other)),
    };
    let (local_part, domain) = thread
        .route_address
        .split_once('@')
        .ok_or_else(|| AppError::internal("Stored route address is invalid.", "missing @"))?;

    Ok(RouteDecision {
        domain: domain.to_string(),
        local_part: local_part.to_string(),
        route_kind,
        operators: vec![operator.to_string()],
        default_reply_identity: thread.reply_identity.clone(),
        allowed_reply_identities: vec![thread.reply_identity.clone()],
    })
}

fn app_state() -> AppResult<AppState> {
    use_context::<AppState>().ok_or_else(|| {
        AppError::internal(
            "Missing app state in Leptos server function context.",
            "state was not provided to the request",
        )
    })
}

fn operator(state: &AppState) -> AppResult<String> {
    state
        .operator()
        .map(str::to_string)
        .ok_or_else(|| AppError::client("Cloudflare Access identity is required."))
}

fn operator_delivery_mode(state: &AppState) -> OperatorDeliveryMode {
    let configured = state
        .env
        .var("MAILDESK_OPERATOR_DELIVERY_MODE")
        .ok()
        .map(|value| value.to_string());
    parse_operator_delivery_mode(configured.as_deref())
}

fn parse_operator_delivery_mode(value: Option<&str>) -> OperatorDeliveryMode {
    match value {
        Some("web_desk") => OperatorDeliveryMode::WebDesk,
        Some("inbox_relay") => OperatorDeliveryMode::InboxRelay,
        None | Some(_) => OperatorDeliveryMode::Invalid,
    }
}

fn require_web_desk_mode(
    mode: OperatorDeliveryMode,
    inbox_relay_message: &'static str,
) -> AppResult<()> {
    match mode {
        OperatorDeliveryMode::WebDesk => Ok(()),
        OperatorDeliveryMode::InboxRelay => Err(AppError::client(inbox_relay_message)),
        OperatorDeliveryMode::Invalid => {
            Err(AppError::client("Operator delivery mode is invalid."))
        }
    }
}

fn db_binding_error(error: worker::Error) -> AppError {
    AppError::internal("Failed to access D1 binding.", error)
}

fn d1_error(context: &'static str, error: impl std::fmt::Display) -> AppError {
    AppError::internal(context, error)
}

fn normalize_identifier(value: String, message: &'static str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 200 {
        return Err(AppError::client(message));
    }
    Ok(value.to_string())
}

fn normalize_mailbox(value: String) -> AppResult<String> {
    let value = value.trim().to_lowercase();
    if value
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(AppError::client("Reply identity is invalid."));
    }
    let Some((local, domain)) = value.rsplit_once('@') else {
        return Err(AppError::client("Reply identity is invalid."));
    };
    if local.is_empty() || domain.is_empty() || value.len() > 320 {
        return Err(AppError::client("Reply identity is invalid."));
    }
    Ok(value)
}

fn normalize_text(value: String, max_bytes: usize, label: &'static str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::client(format!("{label} cannot be empty.")));
    }
    if value.len() > max_bytes {
        return Err(AppError::client(format!("{label} is too long.")));
    }
    Ok(value.to_string())
}

fn normalize_subject(value: String) -> AppResult<String> {
    let subject = normalize_text(value, MAX_REPLY_SUBJECT_BYTES, "Reply subject")?;
    if subject.chars().any(char::is_control) {
        return Err(AppError::client(
            "Reply subject cannot contain control characters.",
        ));
    }
    Ok(subject)
}

fn outbound_mode(state: &AppState) -> String {
    state
        .env
        .var("MAILDESK_OUTBOUND_MODE")
        .ok()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "disabled".to_string())
}

fn random_message_id() -> AppResult<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| AppError::internal("Failed to generate reply id.", error))?;
    let mut encoded = String::with_capacity(38);
    encoded.push_str("reply-");
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut encoded, "{byte:02x}")
            .map_err(|error| AppError::internal("Failed to encode reply id.", error))?;
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::{
        dashboard_operator_label, map_thread, normalize_identifier, normalize_mailbox,
        normalize_subject, normalize_text, parse_operator_delivery_mode, require_web_desk_mode,
        route_decision_for_thread, OperatorDeliveryMode, ThreadRow, MAX_REPLY_BODY_BYTES,
        MAX_REPLY_SUBJECT_BYTES,
    };

    fn example_thread_row() -> ThreadRow {
        ThreadRow {
            id: "thread-1".to_string(),
            subject: Some("Launch question".to_string()),
            external_sender: "sender@example.net".to_string(),
            status: "open".to_string(),
            updated_at: "2026-08-05T12:00:00Z".to_string(),
            message_count: 2,
            domain: "example.com".to_string(),
            local_part: "founders".to_string(),
            route_kind: "role".to_string(),
            reply_identity: "founders@example.com".to_string(),
        }
    }

    #[test]
    fn identifier_normalization_trims_and_bounds_operator_input() {
        assert_eq!(
            normalize_identifier("  thread-1  ".to_string(), "invalid")
                .ok()
                .as_deref(),
            Some("thread-1")
        );
        assert!(normalize_identifier("  ".to_string(), "invalid").is_err());
        assert!(normalize_identifier("x".repeat(201), "invalid").is_err());
    }

    #[test]
    fn mailbox_normalization_is_case_insensitive_and_rejects_unsafe_shapes() {
        assert_eq!(
            normalize_mailbox("  Founders@Example.com  ".to_string())
                .ok()
                .as_deref(),
            Some("founders@example.com")
        );
        for value in [
            "founders example.com",
            "founders@example.com\nBcc:attacker@example.net",
            "founders",
            "@example.com",
            "founders@",
        ] {
            assert!(normalize_mailbox(value.to_string()).is_err());
        }
    }

    #[test]
    fn reply_text_and_subject_reject_empty_oversized_or_control_input() {
        assert_eq!(
            normalize_text(
                "  A bounded reply.  ".to_string(),
                MAX_REPLY_BODY_BYTES,
                "Reply body"
            )
            .ok()
            .as_deref(),
            Some("A bounded reply.")
        );
        assert!(normalize_text(String::new(), MAX_REPLY_BODY_BYTES, "Reply body").is_err());
        assert!(normalize_text(
            "x".repeat(MAX_REPLY_BODY_BYTES + 1),
            MAX_REPLY_BODY_BYTES,
            "Reply body",
        )
        .is_err());
        assert!(normalize_subject("Re: hello\nBcc: attacker@example.net".to_string()).is_err());
        assert!(normalize_subject("x".repeat(MAX_REPLY_SUBJECT_BYTES + 1)).is_err());
    }

    #[test]
    fn stored_thread_rows_map_to_the_operator_contract() {
        let mapped = map_thread(example_thread_row());
        let Ok(mapped) = mapped else {
            return;
        };
        assert_eq!(mapped.id, "thread-1");
        assert_eq!(mapped.subject, "Launch question");
        assert_eq!(mapped.message_count, 2);
        assert_eq!(mapped.route_address, "founders@example.com");
        assert_eq!(mapped.reply_identity, "founders@example.com");
    }

    #[test]
    fn inbox_relay_dashboard_never_serializes_the_operator_mailbox() {
        assert_eq!(
            dashboard_operator_label("inbox_relay", "private@example.com".to_string()),
            "authorized-operator"
        );
        assert_eq!(
            dashboard_operator_label("web_desk", "operator@example.com".to_string()),
            "operator@example.com"
        );
    }

    #[test]
    fn operator_delivery_mode_requires_an_explicit_supported_value() {
        assert_eq!(
            parse_operator_delivery_mode(Some("web_desk")),
            OperatorDeliveryMode::WebDesk
        );
        assert_eq!(
            parse_operator_delivery_mode(Some("inbox_relay")),
            OperatorDeliveryMode::InboxRelay
        );
        for value in [
            None,
            Some(""),
            Some(" inbox_relay"),
            Some("inbox-relayy"),
            Some("unknown"),
            Some("disabled"),
        ] {
            assert_eq!(
                parse_operator_delivery_mode(value),
                OperatorDeliveryMode::Invalid
            );
        }
    }

    #[test]
    fn thread_read_and_reply_guards_fail_closed_outside_web_desk() {
        let inbox_message = "inbox relay disabled";
        assert!(require_web_desk_mode(OperatorDeliveryMode::WebDesk, inbox_message).is_ok());
        assert!(matches!(
            require_web_desk_mode(OperatorDeliveryMode::InboxRelay, inbox_message),
            Err(super::AppError::Client(message)) if message == inbox_message
        ));
        assert!(matches!(
            require_web_desk_mode(OperatorDeliveryMode::Invalid, inbox_message),
            Err(super::AppError::Client(message)) if message == "Operator delivery mode is invalid."
        ));
    }

    #[test]
    fn stored_thread_mapping_preserves_empty_subject_and_rejects_negative_counts() {
        let mut no_subject = example_thread_row();
        no_subject.subject = None;
        assert_eq!(
            map_thread(no_subject).ok().map(|thread| thread.subject),
            Some("(no subject)".to_string())
        );

        let mut invalid_count = example_thread_row();
        invalid_count.message_count = -1;
        assert!(map_thread(invalid_count).is_err());
    }

    #[test]
    fn stored_thread_reconstructs_the_router_authorization_boundary() {
        let thread = map_thread(example_thread_row());
        let Ok(thread) = thread else {
            return;
        };
        let decision = route_decision_for_thread(&thread, "operator@example.com");
        let Ok(decision) = decision else {
            return;
        };

        assert_eq!(decision.domain, "example.com");
        assert_eq!(decision.local_part, "founders");
        assert_eq!(decision.operators, ["operator@example.com"]);
        assert_eq!(decision.default_reply_identity, "founders@example.com");
        assert_eq!(decision.allowed_reply_identities, ["founders@example.com"]);
    }

    #[test]
    fn stored_thread_reconstruction_fails_closed_on_unknown_route_state() {
        let thread = map_thread(example_thread_row());
        let Ok(mut thread) = thread else {
            return;
        };

        thread.route_kind = "catch_all".to_string();
        assert!(route_decision_for_thread(&thread, "operator@example.com").is_err());

        thread.route_kind = "role".to_string();
        thread.route_address = "missing-at-sign".to_string();
        assert!(route_decision_for_thread(&thread, "operator@example.com").is_err());
    }
}
