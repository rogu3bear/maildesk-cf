mod projection;
mod reply_identity;
pub use projection::{project_policy, project_policy_json, PolicyProjection, ProjectedRoute};

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
    #[serde(default)]
    pub policy_version: Option<u32>,
    pub default_reply_mode: ReplyMode,
    #[serde(default)]
    pub accountables: BTreeMap<String, AccountablePolicy>,
    #[serde(default)]
    pub destinations: BTreeMap<String, DestinationPolicy>,
    #[serde(default)]
    pub identity_profiles: BTreeMap<String, IdentityProfile>,
    pub domains: BTreeMap<String, DomainPolicy>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityProfile {
    /// Stable profile records may name their public identity explicitly. A
    /// legacy record omits this field and uses its normalized mailbox key.
    #[serde(default)]
    pub public_address: Option<String>,
    /// Multiple revisions may coexist, but at most one active profile may
    /// resolve a public address.
    #[serde(default = "identity_profile_active_default")]
    pub active: bool,
    pub display_name: String,
    pub signature_profile_ref: String,
    pub signature_text: String,
    pub sender_adapter: SenderAdapter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SenderAdapter {
    CloudflareEmailService,
    Resend,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountablePolicy {
    pub kind: AccountableKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountableKind {
    Team,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DestinationPolicy {
    pub accountable_ref: String,
    pub target: DestinationTarget,
    #[serde(default)]
    pub fallback_destination_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DestinationTarget {
    Mailbox { recipients: Vec<String> },
    WorkQueue { queue_ref: String },
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
    #[serde(default)]
    pub operators: Vec<String>,
    #[serde(default)]
    pub destination_ref: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_profile: Option<ResolvedIdentityProfile>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub operator_reply_identities: BTreeMap<String, OperatorReplyIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disposition: Option<RouteDisposition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperatorReplyIdentity {
    pub public_address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_profile: Option<ResolvedIdentityProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedIdentityProfile {
    pub profile_ref: String,
    pub public_address: String,
    pub display_name: String,
    pub signature_profile_ref: String,
    pub signature_text: String,
    pub sender_adapter: SenderAdapter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteDisposition {
    pub route_ref: String,
    pub candidates: Vec<DispositionCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispositionCandidate {
    pub destination_ref: String,
    pub accountable_ref: String,
    pub target: DestinationTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplyAuthorization {
    pub from_identity: String,
    pub envelope_sender: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_profile: Option<ResolvedIdentityProfile>,
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
    #[error("multiple active identity profiles match: {0}")]
    AmbiguousIdentityProfile(String),
    #[error("operator has no matching configured public identity: {0}")]
    MissingOperatorReplyIdentity(String),
    #[error("reply target is missing")]
    MissingReplyTarget,
    #[error("multiple external reply targets are plausible")]
    AmbiguousReplyTarget,
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
    #[error("unsupported policy version: {0}")]
    UnsupportedPolicyVersion(u32),
    #[error("destination is not configured: {0}")]
    UnknownDestination(String),
    #[error("accountable is not configured: {0}")]
    UnknownAccountable(String),
    #[error("destination fallback cycle includes: {0}")]
    DestinationFallbackCycle(String),
    #[error("invalid destination target: {0}")]
    InvalidDestinationTarget(String),
    #[error("destination chain has no mailbox fallback: {0}")]
    MissingMailboxFallback(String),
    #[error("multiple active identity profiles match: {0}")]
    AmbiguousIdentityProfile(String),
    #[error("identity profile key is not a normalized mailbox: {0}")]
    InvalidIdentityProfileKey(String),
    #[error("identity profile has an invalid display name: {0}")]
    InvalidIdentityDisplayName(String),
    #[error("identity profile has an invalid signature reference: {0}")]
    InvalidSignatureProfileRef(String),
    #[error("identity profile has invalid signature text: {0}")]
    InvalidSignatureText(String),
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

#[derive(Debug, Deserialize)]
struct ReplyTargetAdapterRequest {
    candidates: Vec<String>,
}

#[derive(Debug, Serialize)]
struct ReplyTargetAdapterResponse {
    recipient: String,
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
        return role_decision(policy, domain, local_part, role_policy)
            .and_then(|decision| reply_identity::bind_operator_identities(policy, decision));
    }

    if let Some(personal_policy) = domain_policy.personal_aliases.get(&local_part) {
        return personal_decision(policy, domain, local_part, personal_policy)
            .and_then(|decision| reply_identity::bind_operator_identities(policy, decision));
    }

    if let Some(catch_all_policy) = &domain_policy.catch_all {
        return catch_all_decision(policy, domain, "*".to_string(), catch_all_policy)
            .and_then(|decision| reply_identity::bind_operator_identities(policy, decision));
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

    let personal = decision.operator_reply_identities.get(&operator);
    let identity = requested_identity
        .map(normalize_mailbox)
        .transpose()?
        .unwrap_or_else(|| {
            personal.map_or_else(
                || decision.default_reply_identity.clone(),
                |binding| binding.public_address.clone(),
            )
        });

    if personal.is_some_and(|binding| binding.public_address != identity) {
        return Err(RouteError::UnauthorizedReplyIdentity(identity));
    }

    if !decision
        .allowed_reply_identities
        .iter()
        .any(|allowed| allowed == &identity)
    {
        return Err(RouteError::UnauthorizedReplyIdentity(identity));
    }

    Ok(ReplyAuthorization {
        from_identity: identity.clone(),
        envelope_sender: identity.clone(),
        identity_profile: if let Some(binding) = personal {
            binding.identity_profile.clone()
        } else if decision.default_reply_identity == identity {
            decision.identity_profile.clone()
        } else {
            None
        },
    })
}

/// Resolve the externally visible recipient from durable thread state. Exact
/// normalized duplicates collapse to one value; distinct candidates never
/// acquire ordering or Reply-All semantics.
pub fn resolve_reply_target(candidates: &[String]) -> Result<String, RouteError> {
    let targets = candidates
        .iter()
        .map(|candidate| normalize_mailbox(candidate))
        .collect::<Result<BTreeSet<_>, _>>()?;
    match targets.len() {
        0 => Err(RouteError::MissingReplyTarget),
        1 => targets
            .into_iter()
            .next()
            .ok_or(RouteError::MissingReplyTarget),
        _ => Err(RouteError::AmbiguousReplyTarget),
    }
}

pub fn validate_policy(policy: &RouterPolicy) -> Result<usize, PolicyError> {
    if policy.domains.is_empty() {
        return Err(PolicyError::EmptyPolicy);
    }

    if let Some(version) = policy.policy_version {
        if version != 1 && version != 2 {
            return Err(PolicyError::UnsupportedPolicyVersion(version));
        }
    }

    validate_destinations(policy)?;
    validate_identity_profiles(policy)?;

    let mut route_count = 0usize;
    for (domain, domain_policy) in &policy.domains {
        if domain_policy.role_aliases.is_empty()
            && domain_policy.personal_aliases.is_empty()
            && domain_policy.catch_all.is_none()
        {
            return Err(PolicyError::EmptyDomain(domain.clone()));
        }

        for local_part in domain_policy
            .role_aliases
            .keys()
            .chain(domain_policy.personal_aliases.keys())
        {
            let address = format!("{local_part}@{domain}");
            if local_part == "*"
                || normalize_mailbox(&address).ok().as_deref() != Some(address.as_str())
            {
                return Err(PolicyError::InvalidRoute(
                    local_part.clone(),
                    domain.clone(),
                    RouteError::InvalidRecipient,
                ));
            }
        }
        for (local_part, role_policy) in &domain_policy.role_aliases {
            let decision = route_for_policy_check(policy, local_part, domain)?;
            if role_policy.destination_ref.is_none()
                && !decision
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
            let decision =
                catch_all_decision(policy, domain.clone(), "*".to_string(), catch_all_policy)
                    .and_then(|decision| reply_identity::bind_operator_identities(policy, decision))
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
            validate_policy(&request.policy).map_err(AdapterError::from_policy)?;
            route_message(&request.policy, &request.message).map_err(AdapterError::from_route)
        });

    serialize_adapter_response(result)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn authorize_reply_json(request_json: &str) -> String {
    let result = serde_json::from_str::<ReplyAdapterRequest>(request_json)
        .map_err(AdapterError::invalid_request)
        .and_then(|request| {
            validate_policy(&request.policy).map_err(AdapterError::from_policy)?;
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

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn resolve_reply_target_json(request_json: &str) -> String {
    let result = serde_json::from_str::<ReplyTargetAdapterRequest>(request_json)
        .map_err(AdapterError::invalid_request)
        .and_then(|request| {
            resolve_reply_target(&request.candidates)
                .map(|recipient| ReplyTargetAdapterResponse { recipient })
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
            RouteError::AmbiguousIdentityProfile(_) => "ambiguous_identity_profile",
            RouteError::MissingOperatorReplyIdentity(_) => "missing_operator_reply_identity",
            RouteError::MissingReplyTarget => "reply_target_missing",
            RouteError::AmbiguousReplyTarget => "recipient_ambiguous",
        };

        Self {
            kind: kind.to_string(),
            message: error.to_string(),
        }
    }

    fn from_policy(error: PolicyError) -> Self {
        let kind = match &error {
            PolicyError::AmbiguousIdentityProfile(_)
            | PolicyError::InvalidRoute(_, _, RouteError::AmbiguousIdentityProfile(_)) => {
                "ambiguous_identity_profile"
            }
            _ => "invalid_policy",
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
    policy: &RouterPolicy,
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
            identity_profile: resolved_identity_profile(policy, &role_policy.reply_identity)?,
            operator_reply_identities: BTreeMap::new(),
            disposition: None,
        });
    }

    if let Some(destination_ref) = &role_policy.destination_ref {
        let candidates = destination_candidates(policy, destination_ref);
        let operators = candidates
            .iter()
            .find_map(|candidate| match &candidate.target {
                DestinationTarget::Mailbox { recipients } => Some(recipients.clone()),
                DestinationTarget::WorkQueue { .. } => None,
            })
            .unwrap_or_default();
        return Ok(RouteDecision {
            disposition: Some(RouteDisposition {
                route_ref: format!("route:{domain}:{local_part}"),
                candidates,
            }),
            domain,
            local_part,
            route_kind: RouteKind::RoleAlias,
            operators,
            default_reply_identity: role_policy.reply_identity.clone(),
            allowed_reply_identities,
            identity_profile: resolved_identity_profile(policy, &role_policy.reply_identity)?,
            operator_reply_identities: BTreeMap::new(),
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
        identity_profile: resolved_identity_profile(policy, &role_policy.reply_identity)?,
        operator_reply_identities: BTreeMap::new(),
        disposition: None,
    })
}

fn catch_all_decision(
    policy: &RouterPolicy,
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
            identity_profile: resolved_identity_profile(policy, &catch_all_policy.reply_identity)?,
            operator_reply_identities: BTreeMap::new(),
            disposition: None,
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
        identity_profile: resolved_identity_profile(policy, &catch_all_policy.reply_identity)?,
        operator_reply_identities: BTreeMap::new(),
        disposition: None,
    })
}

fn personal_decision(
    policy: &RouterPolicy,
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
        identity_profile: resolved_identity_profile(policy, &personal_policy.reply_identity)?,
        operator_reply_identities: BTreeMap::new(),
        disposition: None,
    })
}

fn resolved_identity_profile(
    policy: &RouterPolicy,
    identity: &str,
) -> Result<Option<ResolvedIdentityProfile>, RouteError> {
    let public_address = normalize_mailbox(identity)?;
    let mut matches = policy
        .identity_profiles
        .iter()
        .filter_map(|(profile_ref, profile)| {
            if !profile.active {
                return None;
            }
            let candidate = profile.public_address.as_deref().unwrap_or(profile_ref);
            (normalize_mailbox(candidate).ok().as_deref() == Some(public_address.as_str()))
                .then_some((profile_ref, profile))
        });
    let Some((profile_ref, profile)) = matches.next() else {
        return Ok(None);
    };
    if matches.next().is_some() {
        return Err(RouteError::AmbiguousIdentityProfile(public_address));
    }
    Ok(Some(ResolvedIdentityProfile {
        profile_ref: profile_ref.clone(),
        public_address,
        display_name: profile.display_name.trim().to_string(),
        signature_profile_ref: profile.signature_profile_ref.clone(),
        signature_text: profile.signature_text.clone(),
        sender_adapter: profile.sender_adapter,
    }))
}

fn validate_identity_profiles(policy: &RouterPolicy) -> Result<(), PolicyError> {
    let mut active_addresses = BTreeSet::new();
    for (profile_ref, profile) in &policy.identity_profiles {
        if profile_ref.is_empty()
            || profile_ref.len() > 200
            || !profile_ref
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || ":@._-".contains(character))
        {
            return Err(PolicyError::InvalidIdentityProfileKey(profile_ref.clone()));
        }
        let public_address = profile.public_address.as_deref().unwrap_or(profile_ref);
        let normalized = normalize_mailbox(public_address)
            .map_err(|_| PolicyError::InvalidIdentityProfileKey(profile_ref.clone()))?;
        if profile.active && !active_addresses.insert(normalized.clone()) {
            return Err(PolicyError::AmbiguousIdentityProfile(normalized));
        }
        if normalized != public_address {
            return Err(PolicyError::InvalidIdentityProfileKey(profile_ref.clone()));
        }
        let display_name = profile.display_name.trim();
        if display_name.is_empty()
            || display_name.len() > 200
            || display_name.contains(['\r', '\n'])
        {
            return Err(PolicyError::InvalidIdentityDisplayName(profile_ref.clone()));
        }
        let signature_ref = profile.signature_profile_ref.trim();
        if signature_ref.is_empty()
            || signature_ref.len() > 200
            || !signature_ref
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || ":._-".contains(character))
        {
            return Err(PolicyError::InvalidSignatureProfileRef(profile_ref.clone()));
        }
        if profile.signature_text.trim().is_empty()
            || profile.signature_text.len() > 2_000
            || profile.signature_text.contains('\r')
            || profile
                .signature_text
                .chars()
                .any(|character| character.is_control() && character != '\n' && character != '\t')
        {
            return Err(PolicyError::InvalidSignatureText(profile_ref.clone()));
        }
    }
    Ok(())
}

const fn identity_profile_active_default() -> bool {
    true
}

fn destination_candidates(policy: &RouterPolicy, initial_ref: &str) -> Vec<DispositionCandidate> {
    let mut candidates = Vec::new();
    let mut current_ref = Some(initial_ref);
    let mut visited = BTreeSet::new();
    while let Some(destination_ref) = current_ref {
        if !visited.insert(destination_ref.to_string()) {
            break;
        }
        let Some(destination) = policy.destinations.get(destination_ref) else {
            break;
        };
        candidates.push(DispositionCandidate {
            destination_ref: destination_ref.to_string(),
            accountable_ref: destination.accountable_ref.clone(),
            target: destination.target.clone(),
        });
        current_ref = destination.fallback_destination_ref.as_deref();
    }
    candidates
}

fn validate_destinations(policy: &RouterPolicy) -> Result<(), PolicyError> {
    for (destination_ref, destination) in &policy.destinations {
        if !policy
            .accountables
            .contains_key(&destination.accountable_ref)
        {
            return Err(PolicyError::UnknownAccountable(
                destination.accountable_ref.clone(),
            ));
        }
        match &destination.target {
            DestinationTarget::Mailbox { recipients } if recipients.is_empty() => {
                return Err(PolicyError::InvalidDestinationTarget(
                    destination_ref.clone(),
                ));
            }
            DestinationTarget::Mailbox { recipients } => {
                if recipients
                    .iter()
                    .any(|recipient| normalize_mailbox(recipient).is_err())
                {
                    return Err(PolicyError::InvalidDestinationTarget(
                        destination_ref.clone(),
                    ));
                }
            }
            DestinationTarget::WorkQueue { queue_ref } if queue_ref.trim().is_empty() => {
                return Err(PolicyError::InvalidDestinationTarget(
                    destination_ref.clone(),
                ));
            }
            DestinationTarget::WorkQueue { .. } => {}
        }
        if let Some(fallback_ref) = &destination.fallback_destination_ref {
            if !policy.destinations.contains_key(fallback_ref) {
                return Err(PolicyError::UnknownDestination(fallback_ref.clone()));
            }
        }
    }

    for start in policy.destinations.keys() {
        let mut current = Some(start.as_str());
        let mut visited = BTreeSet::new();
        while let Some(destination_ref) = current {
            if !visited.insert(destination_ref.to_string()) {
                return Err(PolicyError::DestinationFallbackCycle(
                    destination_ref.to_string(),
                ));
            }
            current = policy
                .destinations
                .get(destination_ref)
                .and_then(|destination| destination.fallback_destination_ref.as_deref());
        }
    }

    for domain_policy in policy.domains.values() {
        for role in domain_policy.role_aliases.values() {
            if let Some(destination_ref) = &role.destination_ref {
                if !policy.destinations.contains_key(destination_ref) {
                    return Err(PolicyError::UnknownDestination(destination_ref.clone()));
                }
                if !destination_candidates(policy, destination_ref)
                    .iter()
                    .any(|candidate| matches!(candidate.target, DestinationTarget::Mailbox { .. }))
                {
                    return Err(PolicyError::MissingMailboxFallback(destination_ref.clone()));
                }
            }
        }
    }
    Ok(())
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
    let Some((local, domain)) = trimmed.split_once('@') else {
        return Err(RouteError::InvalidRecipient);
    };
    if local.is_empty()
        || local.len() > 64
        || domain.is_empty()
        || domain.len() > 253
        || domain.contains('@')
        || trimmed.contains(char::is_whitespace)
        || trimmed.chars().any(char::is_control)
        || !domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
    {
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
            policy_version: None,
            default_reply_mode: ReplyMode::RoleFirst,
            accountables: BTreeMap::new(),
            destinations: BTreeMap::new(),
            identity_profiles: BTreeMap::new(),
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
    fn route_decision_projects_the_policy_owned_public_identity_profile(
    ) -> Result<(), serde_json::Error> {
        let mut policy = serde_json::to_value(example_policy())?;
        policy["identity_profiles"] = serde_json::json!({
            "founders@example.com": {
                "display_name": "Example Founders",
                "signature_profile_ref": "signature:founders:v1",
                "signature_text": "Example Founders\nexample.com",
                "sender_adapter": "cloudflare_email_service"
            }
        });
        let request = serde_json::json!({
            "policy": policy,
            "message": {
                "envelope_to": "founders@example.com",
                "header_from": "sender@example.net",
                "message_id": "<identity-profile@example.net>",
                "subject": "[send as somebody-else@example.org]"
            }
        });
        let response: serde_json::Value =
            serde_json::from_str(&route_message_json(&request.to_string()))?;

        assert_eq!(response["status"], "ok");
        assert_eq!(
            response["value"]["identity_profile"],
            serde_json::json!({
                "profile_ref": "founders@example.com",
                "public_address": "founders@example.com",
                "display_name": "Example Founders",
                "signature_profile_ref": "signature:founders:v1",
                "signature_text": "Example Founders\nexample.com",
                "sender_adapter": "cloudflare_email_service"
            })
        );
        assert_eq!(
            response["value"]["default_reply_identity"],
            "founders@example.com"
        );
        Ok(())
    }

    #[test]
    fn rejects_multiple_active_profiles_for_one_public_identity() -> Result<(), serde_json::Error> {
        let mut policy = serde_json::to_value(example_policy())?;
        policy["identity_profiles"] = serde_json::json!({
            "identity:founders:v1": {
                "public_address": "founders@example.com",
                "active": true,
                "display_name": "Example Founders",
                "signature_profile_ref": "signature:founders:v1",
                "signature_text": "Example Founders\nexample.com",
                "sender_adapter": "cloudflare_email_service"
            },
            "identity:founders:v2": {
                "public_address": "founders@example.com",
                "active": true,
                "display_name": "Example Founders",
                "signature_profile_ref": "signature:founders:v2",
                "signature_text": "Example Founders\nexample.com",
                "sender_adapter": "cloudflare_email_service"
            }
        });
        let request = serde_json::json!({
            "policy": policy,
            "message": {
                "envelope_to": "founders@example.com",
                "header_from": "sender@example.net"
            }
        });
        let response: serde_json::Value =
            serde_json::from_str(&route_message_json(&request.to_string()))?;

        assert_eq!(response["status"], "error");
        assert_eq!(response["error"]["kind"], "ambiguous_identity_profile");
        Ok(())
    }

    #[test]
    fn selects_the_only_active_stable_profile_ref() -> Result<(), serde_json::Error> {
        let mut policy = serde_json::to_value(example_policy())?;
        policy["identity_profiles"] = serde_json::json!({
            "identity:founders:v1": {
                "public_address": "founders@example.com",
                "active": false,
                "display_name": "Retired Founders",
                "signature_profile_ref": "signature:founders:v1",
                "signature_text": "Retired Founders\nexample.com",
                "sender_adapter": "cloudflare_email_service"
            },
            "identity:founders:v2": {
                "public_address": "founders@example.com",
                "active": true,
                "display_name": "Example Founders",
                "signature_profile_ref": "signature:founders:v2",
                "signature_text": "Example Founders\nexample.com",
                "sender_adapter": "cloudflare_email_service"
            }
        });
        let request = serde_json::json!({
            "policy": policy,
            "message": {
                "envelope_to": "founders@example.com",
                "header_from": "sender@example.net"
            }
        });
        let response: serde_json::Value =
            serde_json::from_str(&route_message_json(&request.to_string()))?;

        assert_eq!(response["status"], "ok");
        assert_eq!(
            response["value"]["identity_profile"]["profile_ref"],
            "identity:founders:v2"
        );
        assert_eq!(
            response["value"]["identity_profile"]["public_address"],
            "founders@example.com"
        );
        Ok(())
    }

    #[test]
    fn resolves_exactly_one_normalized_reply_target() -> Result<(), RouteError> {
        assert_eq!(
            resolve_reply_target(&[
                " Correspondent@Example.NET ".to_string(),
                "correspondent@example.net".to_string(),
            ])?,
            "correspondent@example.net"
        );
        assert_eq!(
            resolve_reply_target(&[]),
            Err(RouteError::MissingReplyTarget)
        );
        assert_eq!(
            resolve_reply_target(&[
                "first@example.net".to_string(),
                "second@example.net".to_string(),
            ]),
            Err(RouteError::AmbiguousReplyTarget)
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

    #[test]
    fn routing_policy_v2_resolves_same_local_part_by_domain_with_body_free_disposition(
    ) -> Result<(), serde_json::Error> {
        let policy: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/routing-policy-v2.json"
        ))?;

        let mailbox_response: serde_json::Value = serde_json::from_str(&route_message_json(
            &serde_json::json!({
                "policy": policy,
                "message": {
                    "envelope_to": "security@example.com",
                    "header_from": "sender@example.org",
                    "message_id": "<mailbox-route@example.org>",
                    "subject": "Mailbox route"
                }
            })
            .to_string(),
        ))?;
        let queue_response: serde_json::Value = serde_json::from_str(&route_message_json(
            &serde_json::json!({
                "policy": policy,
                "message": {
                    "envelope_to": "security@example.net",
                    "header_from": "sender@example.org",
                    "message_id": "<queue-route@example.org>",
                    "subject": "Queue route"
                }
            })
            .to_string(),
        ))?;

        assert_eq!(mailbox_response["status"], "ok");
        assert_eq!(mailbox_response["value"]["domain"], "example.com");
        assert_eq!(
            mailbox_response["value"]["disposition"]["candidates"][0]["destination_ref"],
            "mailbox:security"
        );
        assert_eq!(
            mailbox_response["value"]["disposition"]["candidates"][0]["target"]["kind"],
            "mailbox"
        );
        assert_eq!(queue_response["status"], "ok");
        assert_eq!(queue_response["value"]["domain"], "example.net");
        assert_eq!(
            queue_response["value"]["disposition"]["candidates"][0]["destination_ref"],
            "queue:support"
        );
        assert_eq!(
            queue_response["value"]["disposition"]["candidates"][1]["destination_ref"],
            "mailbox:support"
        );
        assert!(queue_response.to_string().contains("team:support"));
        assert!(!queue_response.to_string().contains("Mailbox route"));
        Ok(())
    }

    #[test]
    fn routing_policy_v2_rejects_destination_fallback_cycles() -> Result<(), serde_json::Error> {
        let policy: RouterPolicy = serde_json::from_value(serde_json::json!({
            "policy_version": 2,
            "default_reply_mode": "role_first",
            "accountables": { "team:ops": { "kind": "team" } },
            "destinations": {
                "queue:a": {
                    "accountable_ref": "team:ops",
                    "target": { "kind": "work_queue", "queue_ref": "queue-a" },
                    "fallback_destination_ref": "queue:b"
                },
                "queue:b": {
                    "accountable_ref": "team:ops",
                    "target": { "kind": "work_queue", "queue_ref": "queue-b" },
                    "fallback_destination_ref": "queue:a"
                }
            },
            "domains": {
                "example.com": {
                    "role_aliases": {
                        "ops": {
                            "destination_ref": "queue:a",
                            "reply_identity": "ops@example.com"
                        }
                    },
                    "personal_aliases": {}
                }
            }
        }))?;

        match validate_policy(&policy) {
            Err(error) => assert_eq!(
                error.to_string(),
                "destination fallback cycle includes: queue:a"
            ),
            Ok(_) => return Err(test_failure("fallback cycle must fail closed")),
        }
        Ok(())
    }

    #[test]
    fn routing_policy_v2_requires_a_terminal_mailbox_projection() -> Result<(), serde_json::Error> {
        let mut policy: RouterPolicy = serde_json::from_str(include_str!(
            "../../../tests/fixtures/routing-policy-v2.json"
        ))?;
        if let Some(destination) = policy.destinations.get_mut("queue:support") {
            destination.fallback_destination_ref = None;
        } else {
            return Err(test_failure("fixture queue destination must exist"));
        }

        match validate_policy(&policy) {
            Err(error) => assert_eq!(
                error.to_string(),
                "destination chain has no mailbox fallback: queue:support"
            ),
            Ok(_) => return Err(test_failure("queue-only routes cannot be activated")),
        }
        Ok(())
    }

    fn sink_policy() -> RouterPolicy {
        let mut role_aliases = BTreeMap::new();
        role_aliases.insert(
            "dmarc".to_string(),
            RoleAliasPolicy {
                operators: vec![],
                destination_ref: None,
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
            policy_version: None,
            default_reply_mode: ReplyMode::RoleFirst,
            accountables: BTreeMap::new(),
            destinations: BTreeMap::new(),
            identity_profiles: BTreeMap::new(),
            domains,
        }
    }

    fn catch_all_policy() -> RouterPolicy {
        let mut role_aliases = BTreeMap::new();
        role_aliases.insert(
            "info".to_string(),
            RoleAliasPolicy {
                operators: vec!["operator-a@example.com".to_string()],
                destination_ref: None,
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
            policy_version: None,
            default_reply_mode: ReplyMode::RoleFirst,
            accountables: BTreeMap::new(),
            destinations: BTreeMap::new(),
            identity_profiles: BTreeMap::new(),
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
                destination_ref: None,
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

        let mut identity_profiles = BTreeMap::new();
        identity_profiles.insert(
            "founders@example.com".to_string(),
            IdentityProfile {
                public_address: None,
                active: true,
                display_name: "Example Founders".to_string(),
                signature_profile_ref: "signature:founders:v1".to_string(),
                signature_text: "Example Founders\nexample.com".to_string(),
                sender_adapter: SenderAdapter::CloudflareEmailService,
            },
        );

        RouterPolicy {
            policy_version: None,
            default_reply_mode: ReplyMode::RoleFirst,
            accountables: BTreeMap::new(),
            destinations: BTreeMap::new(),
            identity_profiles,
            domains,
        }
    }

    fn test_failure(message: &str) -> serde_json::Error {
        serde_json::Error::io(std::io::Error::other(message))
    }
}
