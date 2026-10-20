//! Validated, provider-independent inventory. Never synthesize a recipient to
//! discover a wildcard: that would accidentally select a configured alias.
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyProjection {
    pub schema_version: u32,
    pub routes: Vec<ProjectedRoute>,
    pub protected_operators: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectedRoute {
    pub route_ref: String,
    #[serde(flatten)]
    pub decision: RouteDecision,
}

pub fn project_policy(policy: &RouterPolicy) -> Result<PolicyProjection, PolicyError> {
    validate_policy(policy)?;
    let mut routes = Vec::new();
    for (domain, config) in &policy.domains {
        // The route resolver's role-first precedence also applies to inventory.
        let aliases: BTreeSet<_> = config
            .role_aliases
            .keys()
            .chain(config.personal_aliases.keys())
            .collect();
        for alias in aliases {
            routes.push(
                project_decision(route_for_policy_check(policy, alias, domain)?).map_err(
                    |error| PolicyError::InvalidRoute(alias.clone(), domain.clone(), error),
                )?,
            );
        }
        if let Some(catch_all) = &config.catch_all {
            let decision = catch_all_decision(policy, domain.clone(), "*".into(), catch_all)
                .and_then(|decision| reply_identity::bind_operator_identities(policy, decision))
                .and_then(project_decision)
                .map_err(|error| PolicyError::InvalidRoute("*".into(), domain.clone(), error))?;
            routes.push(decision);
        }
    }
    routes.sort_by(|a, b| {
        (&a.decision.domain, &a.decision.local_part)
            .cmp(&(&b.decision.domain, &b.decision.local_part))
    });
    let mut protected = Vec::new();
    for domain in policy.domains.values() {
        for role in domain.role_aliases.values() {
            protected.extend(role.operators.clone());
        }
        for personal in domain.personal_aliases.values() {
            protected.push(personal.operator.clone());
        }
        if let Some(catch_all) = &domain.catch_all {
            protected.extend(catch_all.operators.clone());
        }
    }
    for destination in policy.destinations.values() {
        if let DestinationTarget::Mailbox { recipients } = &destination.target {
            protected.extend(recipients.clone());
        }
    }
    let protected_operators = normalized_set(&protected)
        .map_err(|error| PolicyError::InvalidRoute("operators".into(), "policy".into(), error))?;
    Ok(PolicyProjection {
        schema_version: 1,
        routes,
        protected_operators,
    })
}

fn project_decision(mut decision: RouteDecision) -> Result<ProjectedRoute, RouteError> {
    decision.operators = normalized_set(&decision.operators)?;
    decision.default_reply_identity = normalize_mailbox(&decision.default_reply_identity)?;
    decision.allowed_reply_identities = normalized_set(&decision.allowed_reply_identities)?;
    if let Some(disposition) = &mut decision.disposition {
        for candidate in &mut disposition.candidates {
            if let DestinationTarget::Mailbox { recipients } = &mut candidate.target {
                *recipients = normalized_set(recipients)?;
            }
        }
    }
    Ok(ProjectedRoute {
        route_ref: format!("route:{}:{}", decision.domain, decision.local_part),
        decision,
    })
}

fn normalized_set(values: &[String]) -> Result<Vec<String>, RouteError> {
    values
        .iter()
        .map(|value| normalize_mailbox(value))
        .collect::<Result<BTreeSet<_>, _>>()
        .map(|set| set.into_iter().collect())
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn project_policy_json(policy_json: &str) -> String {
    serialize_adapter_response(
        serde_json::from_str::<RouterPolicy>(policy_json)
            .map_err(AdapterError::invalid_request)
            .and_then(|policy| project_policy(&policy).map_err(AdapterError::from_policy)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_effective_precedence_wildcards_sinks_and_profiles(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let policy: RouterPolicy = serde_json::from_value(serde_json::json!({
            "default_reply_mode": "role_first",
            "domains": {
                "example.com": {
                    "role_aliases": {
                        "info": {"operators": ["B@example.net", "a@example.net", "b@example.net"], "reply_identity": "info@example.com"},
                        "maildesk-canary": {"operators": [], "reply_identity": "sink@example.com", "sink": true}
                    },
                    "personal_aliases": {"info": {"operator": "other@example.net", "reply_identity": "info@example.com"}},
                    "catch_all": {"operators": ["catch@example.net"], "reply_identity": "info@example.com"}
                },
                "example.org": {"role_aliases": {"info": {"operators": ["third@example.net"], "reply_identity": "info@example.org"}}, "personal_aliases": {}}
            }
        }))?;
        let projection = project_policy(&policy)?;
        assert_eq!(projection.routes.len(), 4);
        assert_eq!(projection.routes[0].decision.local_part, "*");
        assert_eq!(
            projection.routes[0].decision.operators,
            ["catch@example.net"]
        );
        assert_eq!(
            projection.routes[1].decision.operators,
            ["a@example.net", "b@example.net"]
        );
        assert_eq!(
            projection.routes[1].decision.route_kind,
            RouteKind::RoleAlias
        );
        assert!(projection.routes[1].decision.identity_profile.is_none());
        assert_eq!(projection.routes[2].decision.route_kind, RouteKind::Sink);
        assert!(projection.routes[2].decision.operators.is_empty());
        assert_eq!(projection.routes[3].route_ref, "route:example.org:info");
        Ok(())
    }

    #[test]
    fn validates_all_destinations_and_versions_before_projection(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut policy: RouterPolicy = serde_json::from_str(include_str!(
            "../../../tests/fixtures/routing-policy-v2.json"
        ))?;
        let projection = project_policy(&policy)?;
        assert!(projection.routes.iter().any(|route| route
            .decision
            .disposition
            .as_ref()
            .is_some_and(|value| value.candidates.len() > 1)));
        policy.policy_version = Some(99);
        assert!(project_policy(&policy).is_err());
        policy.policy_version = Some(2);
        let key = policy
            .destinations
            .keys()
            .next()
            .ok_or("missing destination")?
            .clone();
        policy
            .destinations
            .get_mut(&key)
            .ok_or("missing destination")?
            .fallback_destination_ref = Some(key.clone());
        assert!(project_policy(&policy).is_err());
        Ok(())
    }
    #[test]
    fn projection_rejects_ambiguous_unused_profiles_and_noncanonical_aliases(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let base = serde_json::json!({
            "default_reply_mode": "role_first",
            "domains": {"example.com": {"role_aliases": {
                "info": {"operators": ["operator@example.net"], "reply_identity": "info@example.com"}
            }, "personal_aliases": {}}}
        });
        for alias in ["Info", " info", "*", "a@b"] {
            let mut value = base.clone();
            value["domains"]["example.com"]["role_aliases"] = serde_json::json!({
                alias: {"operators": ["operator@example.net"], "reply_identity": "info@example.com"}
            });
            let policy: RouterPolicy = serde_json::from_value(value)?;
            assert!(project_policy(&policy).is_err(), "alias {alias} must fail");
        }
        let mut value = base;
        let profile = serde_json::json!({"public_address": "unused@example.com", "display_name": "Unused",
            "signature_profile_ref": "signature:unused:v1", "signature_text": "Unused", "sender_adapter": "resend"});
        value["identity_profiles"] =
            serde_json::json!({"profile:one": profile, "profile:two": profile});
        let policy: RouterPolicy = serde_json::from_value(value.clone())?;
        assert!(matches!(
            project_policy(&policy),
            Err(PolicyError::AmbiguousIdentityProfile(_))
        ));
        value["identity_profiles"]["profile:two"]["active"] = serde_json::json!(false);
        let policy: RouterPolicy = serde_json::from_value(value)?;
        assert!(project_policy(&policy).is_ok());
        Ok(())
    }
}
