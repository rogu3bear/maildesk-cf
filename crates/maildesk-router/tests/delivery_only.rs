use maildesk_router::{
    authorize_reply, project_policy, route_message, InboundMessage, RouterPolicy,
};
use serde_json::json;

#[test]
fn delivery_only_route_preserves_recipient_without_reply_authority(
) -> Result<(), Box<dyn std::error::Error>> {
    let policy: RouterPolicy = serde_json::from_value(json!({
        "policy_version": 3,
        "default_reply_mode": "personal_first",
        "domains": {"example.com": {
            "role_aliases": {
                "reports": {"operators": ["reports@example.net"], "reply_identity": "reports@example.com", "delivery_only": true},
                "support": {"operators": ["alice@example.net"], "reply_identity": "support@example.com"}
            },
            "personal_aliases": {"alice": {"operator": "alice@example.net", "reply_identity": "alice@example.com"}}
        }}
    }))?;
    let route = route_message(
        &policy,
        &InboundMessage {
            envelope_to: "reports@example.com".into(),
            header_from: "sender@example.org".into(),
            message_id: None,
            subject: None,
        },
    )?;
    assert_eq!(route.operators, vec!["reports@example.net"]);
    assert_eq!(serde_json::to_value(&route)?["delivery_only"], true);
    assert!(route.allowed_reply_identities.is_empty());
    assert!(route.identity_profile.is_none());
    assert!(authorize_reply(&route, "reports@example.net", None).is_err());
    assert!(authorize_reply(&route, "reports@example.net", Some("reports@example.com")).is_err());
    assert!(project_policy(&policy).is_ok());
    let support = route_message(
        &policy,
        &InboundMessage {
            envelope_to: "support@example.com".into(),
            header_from: "sender@example.org".into(),
            message_id: None,
            subject: None,
        },
    )?;
    assert_eq!(
        authorize_reply(&support, "alice@example.net", None)?.from_identity,
        "alice@example.com"
    );
    Ok(())
}

#[test]
fn delivery_only_is_not_accepted_in_legacy_policy() -> Result<(), Box<dyn std::error::Error>> {
    let policy: RouterPolicy = serde_json::from_value(json!({
        "policy_version": 2,
        "default_reply_mode": "role_first",
        "domains": {"example.com": {
            "role_aliases": {"reports": {"operators": ["reports@example.net"], "reply_identity": "reports@example.com", "delivery_only": true}},
            "personal_aliases": {}
        }}
    }))?;
    assert!(
        project_policy(&policy).is_err(),
        "legacy policy must not silently enable delivery-only semantics"
    );
    Ok(())
}

#[test]
fn delivery_only_destination_preserves_recipient_and_rejects_conflicting_flags(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut value = json!({
        "policy_version": 3,
        "default_reply_mode": "personal_first",
        "accountables": {"team:reports": {"kind": "team"}},
        "destinations": {"mailbox:reports": {"accountable_ref": "team:reports", "target": {"kind": "mailbox", "recipients": ["reports@example.net"]}}},
        "domains": {"example.com": {
            "role_aliases": {"reports": {"destination_ref": "mailbox:reports", "reply_identity": "reports@example.com", "delivery_only": true}},
            "personal_aliases": {}
        }}
    });
    let policy: RouterPolicy = serde_json::from_value(value.clone())?;
    let projected = project_policy(&policy)?;
    let decision = &projected.routes[0].decision;
    assert_eq!(decision.operators, vec!["reports@example.net"]);
    assert!(decision.allowed_reply_identities.is_empty());
    assert!(authorize_reply(decision, "reports@example.net", None).is_err());
    value["domains"]["example.com"]["role_aliases"]["reports"]["sink"] = json!(true);
    assert!(project_policy(&serde_json::from_value(value.clone())?).is_err());
    value["domains"]["example.com"]["role_aliases"]["reports"]["sink"] = json!(false);
    value["domains"]["example.com"]["role_aliases"]["reports"]["allowed_reply_identities"] =
        json!(["reports@example.com"]);
    assert!(project_policy(&serde_json::from_value(value)?).is_err());
    Ok(())
}
