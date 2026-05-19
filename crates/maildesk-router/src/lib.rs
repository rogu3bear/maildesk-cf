use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleAliasPolicy {
    pub operators: Vec<String>,
    pub reply_identity: String,
    #[serde(default)]
    pub allowed_reply_identities: Vec<String>,
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
        if domain_policy.role_aliases.is_empty() && domain_policy.personal_aliases.is_empty() {
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
    }

    Ok(route_count)
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
    if role_policy.operators.is_empty() {
        return Err(RouteError::EmptyOperators(local_part, domain));
    }

    let mut identities = BTreeSet::new();
    identities.insert(role_policy.reply_identity.clone());
    identities.extend(role_policy.allowed_reply_identities.iter().cloned());

    Ok(RouteDecision {
        domain,
        local_part,
        route_kind: RouteKind::RoleAlias,
        operators: role_policy.operators.clone(),
        default_reply_identity: role_policy.reply_identity.clone(),
        allowed_reply_identities: identities.into_iter().collect(),
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
            },
        );

        RouterPolicy {
            default_reply_mode: ReplyMode::RoleFirst,
            domains,
        }
    }
}
