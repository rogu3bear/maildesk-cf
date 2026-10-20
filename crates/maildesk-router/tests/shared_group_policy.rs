use maildesk_router::{
    authorize_reply, project_policy, route_message, DestinationTarget, InboundMessage,
    RouteDecision, RouteError, RouterPolicy,
};
use std::collections::BTreeMap;

fn policy() -> Result<RouterPolicy, serde_json::Error> {
    serde_json::from_value(serde_json::json!({
        "policy_version": 2,
        "default_reply_mode": "role_first",
        "accountables": {"team:ops": {"kind": "team"}},
        "destinations": {
            "mailbox:shared": {
                "accountable_ref": "team:ops",
                "target": {"kind": "mailbox", "recipients": [
                    "operator-a@example.net", "operator-b@example.net"
                ]}
            },
            "mailbox:restricted": {
                "accountable_ref": "team:ops",
                "target": {"kind": "mailbox", "recipients": ["operator-a@example.net"]}
            }
        },
        "domains": {
            "example.com": {
                "role_aliases": {
                    "support": {"destination_ref": "mailbox:shared", "reply_identity": "support@example.com"},
                    "info": {"destination_ref": "mailbox:shared", "reply_identity": "info@example.com"},
                    "privacy": {"destination_ref": "mailbox:restricted", "reply_identity": "privacy@example.com"}
                },
                "personal_aliases": {
                    "owner": {"operator": "operator-a@example.net", "reply_identity": "owner@example.com"}
                }
            },
            "example.org": {
                "role_aliases": {
                    "support": {"destination_ref": "mailbox:restricted", "reply_identity": "support@example.org"}
                },
                "personal_aliases": {}
            }
        }
    }))
}

fn change_shared_members(
    policy: &mut RouterPolicy,
    members: &[&str],
) -> Result<(), Box<dyn std::error::Error>> {
    let destination = policy
        .destinations
        .get_mut("mailbox:shared")
        .ok_or("shared destination missing")?;
    let DestinationTarget::Mailbox { recipients } = &mut destination.target else {
        return Err("shared destination must remain a mailbox".into());
    };
    *recipients = members.iter().map(|member| (*member).to_string()).collect();
    Ok(())
}

fn inventory(
    policy: &RouterPolicy,
) -> Result<BTreeMap<String, RouteDecision>, Box<dyn std::error::Error>> {
    Ok(project_policy(policy)?
        .routes
        .into_iter()
        .map(|route| (route.route_ref, route.decision))
        .collect())
}

#[test]
fn shared_membership_change_updates_referencing_aliases_only(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut policy = policy()?;
    let before = inventory(&policy)?;
    change_shared_members(
        &mut policy,
        &["operator-a@example.net", "operator-c@example.net"],
    )?;
    let after = inventory(&policy)?;

    assert_eq!(
        before.keys().collect::<Vec<_>>(),
        after.keys().collect::<Vec<_>>()
    );
    for (route_ref, original) in &before {
        let current = after.get(route_ref).ok_or("route disappeared")?;
        if ["route:example.com:info", "route:example.com:support"].contains(&route_ref.as_str()) {
            assert_eq!(
                current.operators,
                ["operator-a@example.net", "operator-c@example.net"]
            );
            assert_eq!(
                current.default_reply_identity,
                original.default_reply_identity
            );
            assert_eq!(
                current.allowed_reply_identities,
                original.allowed_reply_identities
            );
            let candidate = current
                .disposition
                .as_ref()
                .and_then(|disposition| disposition.candidates.first())
                .ok_or("shared route destination missing")?;
            assert_eq!(
                candidate.target,
                DestinationTarget::Mailbox {
                    recipients: vec![
                        "operator-a@example.net".into(),
                        "operator-c@example.net".into()
                    ]
                }
            );
        } else {
            assert_eq!(current, original);
        }
    }
    Ok(())
}

#[test]
fn current_membership_removal_revokes_route_reply_without_broadening_identity(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut policy = policy()?;
    let message = InboundMessage {
        envelope_to: "support@example.com".into(),
        header_from: "sender@example.org".into(),
        message_id: None,
        subject: None,
    };
    let original = route_message(&policy, &message)?;
    assert!(authorize_reply(&original, "operator-b@example.net", None).is_ok());

    change_shared_members(&mut policy, &["operator-a@example.net"])?;
    let current = route_message(&policy, &message)?;
    assert_eq!(
        authorize_reply(&current, "operator-b@example.net", None),
        Err(RouteError::UnauthorizedOperator(
            "operator-b@example.net".into()
        ))
    );
    assert_eq!(
        authorize_reply(&current, "operator-a@example.net", None)?.from_identity,
        "support@example.com"
    );
    assert_eq!(
        authorize_reply(
            &current,
            "operator-a@example.net",
            Some("privacy@example.com")
        ),
        Err(RouteError::UnauthorizedReplyIdentity(
            "privacy@example.com".into()
        ))
    );
    Ok(())
}
