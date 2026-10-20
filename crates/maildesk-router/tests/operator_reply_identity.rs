use maildesk_router::{
    authorize_reply, project_policy, route_message, InboundMessage, ReplyMode, RouteError,
    RouterPolicy,
};
use serde_json::json;

fn policy() -> Result<RouterPolicy, serde_json::Error> {
    let mut domains = serde_json::Map::new();
    let mut profiles = serde_json::Map::new();
    for domain in ["example.com", "example.org"] {
        domains.insert(domain.into(), json!({
            "role_aliases": {"support": {"operators": ["operator-a@example.net", "operator-b@example.net"], "reply_identity": format!("support@{domain}")}},
            "personal_aliases": {
                "operator-a": {"operator": "operator-a@example.net", "reply_identity": format!("operator-a@{domain}")},
                "operator-b": {"operator": "operator-b@example.net", "reply_identity": format!("operator-b@{domain}")}
            },
            "catch_all": {"operators": ["operator-a@example.net", "operator-b@example.net"], "reply_identity": format!("support@{domain}")}
        }));
        for prefix in ["support", "operator-a", "operator-b"] {
            profiles.insert(format!("{prefix}@{domain}"), json!({
                "display_name": "Example Operator", "signature_profile_ref": "signature:example",
                "signature_text": "Example signature", "sender_adapter": "cloudflare_email_service"
            }));
        }
    }
    serde_json::from_value(
        json!({"default_reply_mode": "personal_first", "domains": domains, "identity_profiles": profiles}),
    )
}

fn route(policy: &RouterPolicy, to: &str) -> Result<maildesk_router::RouteDecision, RouteError> {
    route_message(
        policy,
        &InboundMessage {
            envelope_to: to.into(),
            header_from: "untrusted@example.org".into(),
            message_id: None,
            subject: None,
        },
    )
}

#[test]
fn personal_first_preserves_operator_prefix_and_original_domain(
) -> Result<(), Box<dyn std::error::Error>> {
    let policy = policy()?;
    for domain in ["example.com", "example.org"] {
        let decision = route(&policy, &format!("support@{domain}"))?;
        assert_eq!(decision.operators.len(), 2);
        for prefix in ["operator-a", "operator-b"] {
            let auth = authorize_reply(&decision, &format!("{prefix}@example.net"), None)?;
            assert_eq!(auth.from_identity, format!("{prefix}@{domain}"));
            assert_eq!(auth.envelope_sender, auth.from_identity);
            assert_eq!(
                auth.identity_profile
                    .ok_or("profile missing")?
                    .public_address,
                auth.from_identity
            );
        }
        let catch_all = route(&policy, &format!("unknown@{domain}"))?;
        assert_eq!(
            catch_all.operator_reply_identities,
            decision.operator_reply_identities
        );
    }
    let projection = project_policy(&policy)?;
    let wildcard = projection
        .routes
        .iter()
        .find(|r| r.route_ref == "route:example.com:*")
        .ok_or("wildcard missing")?;
    assert_eq!(
        wildcard.decision.operator_reply_identities,
        route(&policy, "unknown@example.com")?.operator_reply_identities
    );
    Ok(())
}

#[test]
fn operator_cannot_choose_another_prefix_role_or_domain() -> Result<(), Box<dyn std::error::Error>>
{
    let decision = route(&policy()?, "support@example.com")?;
    for requested in [
        "operator-b@example.com",
        "support@example.com",
        "operator-a@example.org",
        "operator-a@example.net",
    ] {
        assert!(matches!(
            authorize_reply(&decision, "operator-a@example.net", Some(requested)),
            Err(RouteError::UnauthorizedReplyIdentity(_))
        ));
    }
    assert!(matches!(
        authorize_reply(&decision, "outsider@example.net", None),
        Err(RouteError::UnauthorizedOperator(_))
    ));
    Ok(())
}

#[test]
fn personal_first_requires_explicit_matching_personal_alias(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut policy = policy()?;
    policy
        .domains
        .get_mut("example.com")
        .ok_or("domain missing")?
        .personal_aliases
        .remove("operator-a");
    assert!(matches!(
        route(&policy, "support@example.com"),
        Err(RouteError::MissingOperatorReplyIdentity(_))
    ));
    assert!(project_policy(&policy).is_err());
    Ok(())
}

#[test]
fn role_first_remains_explicit_and_member_removal_removes_send_authority(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut policy = policy()?;
    policy.default_reply_mode = ReplyMode::RoleFirst;
    assert_eq!(
        authorize_reply(
            &route(&policy, "support@example.com")?,
            "operator-a@example.net",
            None
        )?
        .from_identity,
        "support@example.com"
    );
    policy.default_reply_mode = ReplyMode::PersonalFirst;
    policy
        .domains
        .get_mut("example.com")
        .ok_or("domain missing")?
        .role_aliases
        .get_mut("support")
        .ok_or("role missing")?
        .operators = vec!["operator-b@example.net".into()];
    let decision = route(&policy, "support@example.com")?;
    assert!(matches!(
        authorize_reply(&decision, "operator-a@example.net", None),
        Err(RouteError::UnauthorizedOperator(_))
    ));
    assert_eq!(decision.operator_reply_identities.len(), 1);
    Ok(())
}
