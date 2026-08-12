use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::wasm_bindgen;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboundMessage {
    pub envelope_to: String,
    pub header_from: String,
    pub message_id: Option<String>,
    pub subject: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouterPolicy {
    pub default_reply_mode: ReplyMode,
    pub domains: BTreeMap<String, DomainPolicy>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DomainPolicy {
    pub role_aliases: BTreeMap<String, RoleAliasPolicy>,
    pub personal_aliases: BTreeMap<String, PersonalAliasPolicy>,
    /// Optional fallback for any recipient that matches no role or personal
    /// alias. When present, the domain never rejects unknown local-parts; the
    /// message is forwarded to these operators instead.
    #[serde(default)]
    pub catch_all: Option<CatchAllPolicy>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleAliasPolicy {
    pub operators: Vec<String>,
    pub reply_identity: String,
    #[serde(default)]
    pub allowed_reply_identities: Vec<String>,
    /// When true, inbound mail to this alias is accepted and archived (R2 + D1)
    /// but never forwarded to operators. Intended for bulk machine mail such as
    /// DMARC aggregate reports. A sink alias may declare an empty operator set;
    /// any operators it does list are ignored while `sink` is true.
    #[serde(default)]
    pub sink: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatchAllPolicy {
    pub operators: Vec<String>,
    pub reply_identity: String,
    #[serde(default)]
    pub allowed_reply_identities: Vec<String>,
    /// See `RoleAliasPolicy::sink`. A sink catch-all archives unmatched mail
    /// without forwarding it.
    #[serde(default)]
    pub sink: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonalAliasPolicy {
    pub operator: String,
    pub reply_identity: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplyMode {
    RoleFirst,
    PersonalFirst,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteDecision {
    pub domain: String,
    pub local_part: String,
    pub route_kind: RouteKind,
    pub operators: Vec<String>,
    pub default_reply_identity: String,
    pub allowed_reply_identities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplyAuthorization {
    pub from_identity: String,
    pub envelope_sender: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteKind {
    RoleAlias,
    PersonalAlias,
    CatchAll,
    /// Store-only: the message is archived but not forwarded to any operator.
    Sink,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RouteError {
    #[error("recipient is not a valid mailbox address")]
    InvalidRecipient,
    #[error("domain is not configured: {0}")]
    UnknownDomain(String),
    #[error("alias is not configured: {0}@{1}")]
    UnknownAlias(String, String),
    #[error("policy has an empty operator set for: {0}@{1}")]
    EmptyOperators(String, String),
    #[error("sender is not an operator on the route: {0}")]
    UnauthorizedOperator(String),
    #[error("reply identity is not allowed for this route: {0}")]
    UnauthorizedReplyIdentity(String),
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PolicyError {
    #[error("policy contains no domains")]
    EmptyPolicy,
    #[error("domain has no aliases: {0}")]
    EmptyDomain(String),
    #[error("invalid route for {0}@{1}: {2}")]
    InvalidRoute(String, String, RouteError),
    #[error("role reply identity must be part of its allowed identities: {0}@{1}")]
    MissingRoleReplyIdentity(String, String),
    #[error("personal reply identity must match the alias address: {0}@{1}")]
    PersonalReplyIdentityMismatch(String, String),
}

#[derive(Debug, Deserialize)]
struct RouteAdapterRequest {
    policy: RouterPolicy,
    message: InboundMessage,
}

#[derive(Debug, Deserialize)]
struct ReplyAdapterRequest {
    policy: RouterPolicy,
    envelope_to: String,
    operator: String,
    requested_identity: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum AdapterResponse<T> {
    Ok { value: T },
    Error { error: AdapterError },
}

#[derive(Debug, Serialize)]
struct AdapterError {
    kind: String,
    message: String,
}

pub fn route_message(
    policy: &RouterPolicy,
    message: &InboundMessage,
) -> Result<RouteDecision, RouteError> {
    let (local_part, domain) = split_mailbox(&message.envelope_to)?;
    let domain_policy = policy
        .domains
        .get(&domain)
        .ok_or_else(|| RouteError::UnknownDomain(domain.clone()))?;

    if let Some(role_policy) = domain_policy.role_aliases.get(&local_part) {
        return role_decision(domain, local_part, role_policy);
    }

    if let Some(personal_policy) = domain_policy.personal_aliases.get(&local_part) {
        return personal_decision(domain, local_part, personal_policy);
    }

    if let Some(catch_all_policy) = &domain_policy.catch_all {
        return catch_all_decision(domain, "*".to_string(), catch_all_policy);
    }

    Err(RouteError::UnknownAlias(local_part, domain))
}

pub fn authorize_reply(
    decision: &RouteDecision,
    operator: &str,
    requested_identity: Option<&str>,
) -> Result<ReplyAuthorization, RouteError> {
    let operator = normalize_mailbox(operator)?;
    if !decision
        .operators
        .iter()
        .any(|allowed| allowed == &operator)
    {
        return Err(RouteError::UnauthorizedOperator(operator));
    }

    let identity = requested_identity
        .map(normalize_mailbox)
        .transpose()?
        .unwrap_or_else(|| decision.default_reply_identity.clone());

    if !decision
        .allowed_reply_identities
        .iter()
        .any(|allowed| allowed == &identity)
    {
        return Err(RouteError::UnauthorizedReplyIdentity(identity));
    }

    Ok(ReplyAuthorization {
        from_identity: identity.clone(),
        envelope_sender: identity,
    })
}

pub fn validate_policy(policy: &RouterPolicy) -> Result<usize, PolicyError> {
    if policy.domains.is_empty() {
        return Err(PolicyError::EmptyPolicy);
    }

    let mut route_count = 0usize;
    for (domain, domain_policy) in &policy.domains {
        if domain_policy.role_aliases.is_empty()
            && domain_policy.personal_aliases.is_empty()
            && domain_policy.catch_all.is_none()
        {
            return Err(PolicyError::EmptyDomain(domain.clone()));
        }

        for (local_part, role_policy) in &domain_policy.role_aliases {
            let decision = route_for_policy_check(policy, local_part, domain)?;
            if !decision
                .allowed_reply_identities
                .contains(&role_policy.reply_identity)
            {
                return Err(PolicyError::MissingRoleReplyIdentity(
                    local_part.clone(),
                    domain.clone(),
                ));
            }
            route_count += 1;
        }

        for (local_part, personal_policy) in &domain_policy.personal_aliases {
            route_for_policy_check(policy, local_part, domain)?;
            let expected_identity = format!("{local_part}@{domain}");
            if personal_policy.reply_identity != expected_identity {
                return Err(PolicyError::PersonalReplyIdentityMismatch(
                    local_part.clone(),
                    domain.clone(),
                ));
            }
            route_count += 1;
        }

        if let Some(catch_all_policy) = &domain_policy.catch_all {
            let decision = catch_all_decision(domain.clone(), "*".to_string(), catch_all_policy)
                .map_err(|error| {
                    PolicyError::InvalidRoute("*".to_string(), domain.clone(), error)
                })?;
            if !decision
                .allowed_reply_identities
                .contains(&catch_all_policy.reply_identity)
            {
                return Err(PolicyError::MissingRoleReplyIdentity(
                    "*".to_string(),
                    domain.clone(),
                ));
            }
            route_count += 1;
        }
    }

    Ok(route_count)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn route_message_json(request_json: &str) -> String {
    let result = serde_json::from_str::<RouteAdapterRequest>(request_json)
        .map_err(AdapterError::invalid_request)
        .and_then(|request| {
            route_message(&request.policy, &request.message).map_err(AdapterError::from_route)
        });

    serialize_adapter_response(result)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn authorize_reply_json(request_json: &str) -> String {
    let result = serde_json::from_str::<ReplyAdapterRequest>(request_json)
        .map_err(AdapterError::invalid_request)
        .and_then(|request| {
            let decision = route_message(
                &request.policy,
                &InboundMessage {
                    envelope_to: request.envelope_to,
                    header_from: String::new(),
                    message_id: None,
                    subject: None,
                },
            )
            .map_err(AdapterError::from_route)?;

            authorize_reply(
                &decision,
                &request.operator,
                request.requested_identity.as_deref(),
            )
            .map_err(AdapterError::from_route)
        });

    serialize_adapter_response(result)
}

fn serialize_adapter_response<T: Serialize>(result: Result<T, AdapterError>) -> String {
    let response = match result {
        Ok(value) => AdapterResponse::Ok { value },
        Err(error) => AdapterResponse::Error { error },
    };

    match serde_json::to_string(&response) {
        Ok(json) => json,
        Err(_) => {
            r#"{"status":"error","error":{"kind":"serialization","message":"adapter response serialization failed"}}"#
                .to_string()
        }
    }
}

impl AdapterError {
    fn invalid_request(error: serde_json::Error) -> Self {
        Self {
            kind: "invalid_request".to_string(),
            message: error.to_string(),
        }
    }

    fn from_route(error: RouteError) -> Self {
        let kind = match &error {
            RouteError::InvalidRecipient => "invalid_recipient",
            RouteError::UnknownDomain(_) => "unknown_domain",
            RouteError::UnknownAlias(_, _) => "unknown_alias",
            RouteError::EmptyOperators(_, _) => "empty_operators",
            RouteError::UnauthorizedOperator(_) => "unauthorized_operator",
            RouteError::UnauthorizedReplyIdentity(_) => "unauthorized_reply_identity",
        };

        Self {
            kind: kind.to_string(),
            message: error.to_string(),
        }
    }
}

fn route_for_policy_check(
    policy: &RouterPolicy,
    local_part: &str,
    domain: &str,
) -> Result<RouteDecision, PolicyError> {
    route_message(
        policy,
        &InboundMessage {
            envelope_to: format!("{local_part}@{domain}"),
            header_from: "sender@example.net".to_string(),
            message_id: None,
            subject: None,
        },
    )
    .map_err(|error| PolicyError::InvalidRoute(local_part.to_string(), domain.to_string(), error))
}

fn role_decision(
    domain: String,
    local_part: String,
    role_policy: &RoleAliasPolicy,
) -> Result<RouteDecision, RouteError> {
    let mut identities = BTreeSet::new();
    identities.insert(role_policy.reply_identity.clone());
    identities.extend(role_policy.allowed_reply_identities.iter().cloned());
    let allowed_reply_identities: Vec<String> = identities.into_iter().collect();

    if role_policy.sink {
        return Ok(RouteDecision {
            domain,
            local_part,
            route_kind: RouteKind::Sink,
            operators: Vec::new(),
            default_reply_identity: role_policy.reply_identity.clone(),
            allowed_reply_identities,
        });
    }

    if role_policy.operators.is_empty() {
        return Err(RouteError::EmptyOperators(local_part, domain));
    }

    Ok(RouteDecision {
        domain,
        local_part,
        route_kind: RouteKind::RoleAlias,
        operators: role_policy.operators.clone(),
        default_reply_identity: role_policy.reply_identity.clone(),
        allowed_reply_identities,
    })
}

fn catch_all_decision(
    domain: String,
    local_part: String,
    catch_all_policy: &CatchAllPolicy,
) -> Result<RouteDecision, RouteError> {
    let mut identities = BTreeSet::new();
    identities.insert(catch_all_policy.reply_identity.clone());
    identities.extend(catch_all_policy.allowed_reply_identities.iter().cloned());
    let allowed_reply_identities: Vec<String> = identities.into_iter().collect();

    if catch_all_policy.sink {
        return Ok(RouteDecision {
            domain,
            local_part,
            route_kind: RouteKind::Sink,
            operators: Vec::new(),
            default_reply_identity: catch_all_policy.reply_identity.clone(),
            allowed_reply_identities,
        });
    }

    if catch_all_policy.operators.is_empty() {
        return Err(RouteError::EmptyOperators(local_part, domain));
    }

    Ok(RouteDecision {
        domain,
        local_part,
        route_kind: RouteKind::CatchAll,
        operators: catch_all_policy.operators.clone(),
        default_reply_identity: catch_all_policy.reply_identity.clone(),
        allowed_reply_identities,
    })
}

fn personal_decision(
    domain: String,
    local_part: String,
    personal_policy: &PersonalAliasPolicy,
) -> Result<RouteDecision, RouteError> {
    if personal_policy.operator.trim().is_empty() {
        return Err(RouteError::EmptyOperators(local_part, domain));
    }

    Ok(RouteDecision {
        domain,
        local_part,
        route_kind: RouteKind::PersonalAlias,
        operators: vec![personal_policy.operator.clone()],
        default_reply_identity: personal_policy.reply_identity.clone(),
        allowed_reply_identities: vec![personal_policy.reply_identity.clone()],
    })
}

fn split_mailbox(address: &str) -> Result<(String, String), RouteError> {
    let trimmed = normalize_mailbox(address)?;
    let (local, domain) = trimmed
        .split_once('@')
        .ok_or(RouteError::InvalidRecipient)?;

    if local.is_empty() || domain.is_empty() || domain.contains('@') {
        return Err(RouteError::InvalidRecipient);
    }

    Ok((local.to_string(), domain.to_string()))
}

fn normalize_mailbox(address: &str) -> Result<String, RouteError> {
    let trimmed = address.trim().to_ascii_lowercase();
    if trimmed.is_empty() || trimmed.contains(char::is_whitespace) {
        return Err(RouteError::InvalidRecipient);
    }

    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_role_alias_to_all_policy_operators() -> Result<(), RouteError> {
        let policy = example_policy();
        let decision = route_message(
            &policy,
            &InboundMessage {
                envelope_to: "Founders@Example.com".to_string(),
                header_from: "customer@example.net".to_string(),
                message_id: Some("<message-1@example.net>".to_string()),
                subject: Some("Hello".to_string()),
            },
        )?;

        assert_eq!(decision.domain, "example.com");
        assert_eq!(decision.local_part, "founders");
        assert_eq!(decision.route_kind, RouteKind::RoleAlias);
        assert_eq!(decision.default_reply_identity, "founders@example.com");
        assert_eq!(
            decision.operators,
            vec![
                "operator-a@example.com".to_string(),
                "operator-b@example.com".to_string()
            ]
        );
        assert_eq!(
            decision.allowed_reply_identities,
            vec![
                "founders@example.com".to_string(),
                "operator-a@example.com".to_string(),
                "operator-b@example.com".to_string()
            ]
        );

        Ok(())
    }

    #[test]
    fn routes_personal_alias_to_one_operator() -> Result<(), RouteError> {
        let policy = example_policy();
        let decision = route_message(
            &policy,
            &InboundMessage {
                envelope_to: "operator-a@example.com".to_string(),
                header_from: "customer@example.net".to_string(),
                message_id: None,
                subject: None,
            },
        )?;

        assert_eq!(decision.route_kind, RouteKind::PersonalAlias);
        assert_eq!(decision.operators, vec!["operator-a@example.com"]);
        assert_eq!(decision.default_reply_identity, "operator-a@example.com");

        Ok(())
    }

    #[test]
    fn rejects_unknown_alias() {
        let policy = example_policy();
        let result = route_message(
            &policy,
            &InboundMessage {
                envelope_to: "unknown@example.com".to_string(),
                header_from: "customer@example.net".to_string(),
                message_id: None,
                subject: None,
            },
        );

        let error = match result {
            Ok(decision) => {
                assert_eq!(decision.local_part, "unreachable");
                return;
            }
            Err(error) => error,
        };

        assert_eq!(
            error,
            RouteError::UnknownAlias("unknown".to_string(), "example.com".to_string())
        );
    }

    #[test]
    fn authorizes_default_reply_identity_for_route_operator() -> Result<(), RouteError> {
        let policy = example_policy();
        let decision = route_message(
            &policy,
            &InboundMessage {
                envelope_to: "founders@example.com".to_string(),
                header_from: "customer@example.net".to_string(),
                message_id: None,
                subject: None,
            },
        )?;

        let authorization = authorize_reply(&decision, "operator-a@example.com", None)?;

        assert_eq!(authorization.from_identity, "founders@example.com");
        assert_eq!(authorization.envelope_sender, "founders@example.com");

        Ok(())
    }

    #[test]
    fn rejects_operator_not_on_route() -> Result<(), RouteError> {
        let policy = example_policy();
        let decision = route_message(
            &policy,
            &InboundMessage {
                envelope_to: "founders@example.com".to_string(),
                header_from: "customer@example.net".to_string(),
                message_id: None,
                subject: None,
            },
        )?;

        let error = match authorize_reply(&decision, "outsider@example.com", None) {
            Ok(authorization) => {
                assert_eq!(authorization.from_identity, "unreachable");
                return Ok(());
            }
            Err(error) => error,
        };

        assert_eq!(
            error,
            RouteError::UnauthorizedOperator("outsider@example.com".to_string())
        );

        Ok(())
    }

    #[test]
    fn validates_policy_shape() -> Result<(), PolicyError> {
        let policy = example_policy();
        assert_eq!(validate_policy(&policy)?, 2);
        Ok(())
    }

    #[test]
    fn routes_unknown_alias_to_catch_all_when_present() -> Result<(), RouteError> {
        let policy = catch_all_policy();
        let decision = route_message(
            &policy,
            &InboundMessage {
                envelope_to: "Anything-Unlisted@Example.com".to_string(),
                header_from: "customer@example.net".to_string(),
                message_id: None,
                subject: None,
            },
        )?;

        assert_eq!(decision.route_kind, RouteKind::CatchAll);
        assert_eq!(decision.local_part, "*");
        assert_eq!(decision.operators, vec!["operator-a@example.com"]);
        assert_eq!(decision.default_reply_identity, "info@example.com");
        assert!(decision
            .allowed_reply_identities
            .contains(&"info@example.com".to_string()));

        Ok(())
    }

    #[test]
    fn role_alias_still_wins_over_catch_all() -> Result<(), RouteError> {
        let policy = catch_all_policy();
        let decision = route_message(
            &policy,
            &InboundMessage {
                envelope_to: "info@example.com".to_string(),
                header_from: "customer@example.net".to_string(),
                message_id: None,
                subject: None,
            },
        )?;

        assert_eq!(decision.route_kind, RouteKind::RoleAlias);
        Ok(())
    }

    #[test]
    fn catch_all_only_domain_validates() -> Result<(), PolicyError> {
        let mut domains = BTreeMap::new();
        domains.insert(
            "example.com".to_string(),
            DomainPolicy {
                role_aliases: BTreeMap::new(),
                personal_aliases: BTreeMap::new(),
                catch_all: Some(CatchAllPolicy {
                    operators: vec!["operator-a@example.com".to_string()],
                    reply_identity: "info@example.com".to_string(),
                    allowed_reply_identities: vec![],
                    sink: false,
                }),
            },
        );
        let policy = RouterPolicy {
            default_reply_mode: ReplyMode::RoleFirst,
            domains,
        };
        assert_eq!(validate_policy(&policy)?, 1);
        Ok(())
    }

    #[test]
    fn routes_sink_role_alias_without_forwarding() -> Result<(), RouteError> {
        let policy = sink_policy();
        let decision = route_message(
            &policy,
            &InboundMessage {
                envelope_to: "DMARC@Example.com".to_string(),
                header_from: "noreply-dmarc-support@google.com".to_string(),
                message_id: Some("<report-1@google.com>".to_string()),
                subject: Some("Report domain: example.com".to_string()),
            },
        )?;

        assert_eq!(decision.route_kind, RouteKind::Sink);
        assert_eq!(decision.local_part, "dmarc");
        assert!(decision.operators.is_empty());
        assert_eq!(decision.default_reply_identity, "dmarc@example.com");

        Ok(())
    }

    #[test]
    fn validates_policy_with_sink_alias() -> Result<(), PolicyError> {
        // A sink alias is valid even though it forwards to no operator.
        assert_eq!(validate_policy(&sink_policy())?, 1);
        Ok(())
    }

    #[test]
    fn json_adapter_serializes_route_decisions() -> Result<(), serde_json::Error> {
        let request = serde_json::json!({
            "policy": example_policy(),
            "message": {
                "envelope_to": "founders@example.com",
                "header_from": "sender@example.net",
                "message_id": "<adapter-route@example.net>",
                "subject": "Adapter route"
            }
        });
        let response: serde_json::Value =
            serde_json::from_str(&route_message_json(&request.to_string()))?;

        assert_eq!(response["status"], "ok");
        assert_eq!(response["value"]["route_kind"], "role_alias");
        assert_eq!(
            response["value"]["default_reply_identity"],
            "founders@example.com"
        );
        Ok(())
    }

    #[test]
    fn json_adapter_preserves_typed_reply_rejections() -> Result<(), serde_json::Error> {
        let request = serde_json::json!({
            "policy": example_policy(),
            "envelope_to": "founders@example.com",
            "operator": "outsider@example.com",
            "requested_identity": "founders@example.com"
        });
        let response: serde_json::Value =
            serde_json::from_str(&authorize_reply_json(&request.to_string()))?;

        assert_eq!(response["status"], "error");
        assert_eq!(response["error"]["kind"], "unauthorized_operator");
        assert_eq!(
            response["error"]["message"],
            "sender is not an operator on the route: outsider@example.com"
        );
        Ok(())
    }

    fn sink_policy() -> RouterPolicy {
        let mut role_aliases = BTreeMap::new();
        role_aliases.insert(
            "dmarc".to_string(),
            RoleAliasPolicy {
                operators: vec![],
                reply_identity: "dmarc@example.com".to_string(),
                allowed_reply_identities: vec![],
                sink: true,
            },
        );

        let mut domains = BTreeMap::new();
        domains.insert(
            "example.com".to_string(),
            DomainPolicy {
                role_aliases,
                personal_aliases: BTreeMap::new(),
                catch_all: None,
            },
        );

        RouterPolicy {
            default_reply_mode: ReplyMode::RoleFirst,
            domains,
        }
    }

    fn catch_all_policy() -> RouterPolicy {
        let mut role_aliases = BTreeMap::new();
        role_aliases.insert(
            "info".to_string(),
            RoleAliasPolicy {
                operators: vec!["operator-a@example.com".to_string()],
                reply_identity: "info@example.com".to_string(),
                allowed_reply_identities: vec!["operator-a@example.com".to_string()],
                sink: false,
            },
        );

        let mut domains = BTreeMap::new();
        domains.insert(
            "example.com".to_string(),
            DomainPolicy {
                role_aliases,
                personal_aliases: BTreeMap::new(),
                catch_all: Some(CatchAllPolicy {
                    operators: vec!["operator-a@example.com".to_string()],
                    reply_identity: "info@example.com".to_string(),
                    allowed_reply_identities: vec!["operator-a@example.com".to_string()],
                    sink: false,
                }),
            },
        );

        RouterPolicy {
            default_reply_mode: ReplyMode::RoleFirst,
            domains,
        }
    }

    fn example_policy() -> RouterPolicy {
        let mut role_aliases = BTreeMap::new();
        role_aliases.insert(
            "founders".to_string(),
            RoleAliasPolicy {
                operators: vec![
                    "operator-a@example.com".to_string(),
                    "operator-b@example.com".to_string(),
                ],
                reply_identity: "founders@example.com".to_string(),
                allowed_reply_identities: vec![
                    "operator-a@example.com".to_string(),
                    "operator-b@example.com".to_string(),
                ],
                sink: false,
            },
        );

        let mut personal_aliases = BTreeMap::new();
        personal_aliases.insert(
            "operator-a".to_string(),
            PersonalAliasPolicy {
                operator: "operator-a@example.com".to_string(),
                reply_identity: "operator-a@example.com".to_string(),
            },
        );

        let mut domains = BTreeMap::new();
        domains.insert(
            "example.com".to_string(),
            DomainPolicy {
                role_aliases,
                personal_aliases,
                catch_all: None,
            },
        );

        RouterPolicy {
            default_reply_mode: ReplyMode::RoleFirst,
            domains,
        }
    }
}
