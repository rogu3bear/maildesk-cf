//! Personal-first replies retain the authenticated operator's local part and
//! the receiving domain. A configured personal alias is mandatory: never infer
//! send-as authority from a header or construct an undeclared public address.
use super::*;

pub(super) fn bind_operator_identities(
    policy: &RouterPolicy,
    mut decision: RouteDecision,
) -> Result<RouteDecision, RouteError> {
    if policy.default_reply_mode != ReplyMode::PersonalFirst
        || decision.route_kind == RouteKind::Sink
    {
        return Ok(decision);
    }
    let domain = policy
        .domains
        .get(&decision.domain)
        .ok_or_else(|| RouteError::UnknownDomain(decision.domain.clone()))?;
    decision.operators = decision
        .operators
        .iter()
        .map(|value| normalize_mailbox(value))
        .collect::<Result<BTreeSet<_>, _>>()?
        .into_iter()
        .collect();
    for operator in &decision.operators {
        let operator = normalize_mailbox(operator)?;
        let (prefix, _) = split_mailbox(&operator)?;
        let configured = domain
            .personal_aliases
            .get(&prefix)
            .filter(|_| !domain.role_aliases.contains_key(&prefix))
            .filter(|personal| {
                normalize_mailbox(&personal.operator).ok().as_ref() == Some(&operator)
            })
            .ok_or_else(|| RouteError::MissingOperatorReplyIdentity(operator.clone()))?;
        let address = normalize_mailbox(&configured.reply_identity)?;
        if address != format!("{prefix}@{}", decision.domain) {
            return Err(RouteError::MissingOperatorReplyIdentity(operator));
        }
        decision.operator_reply_identities.insert(
            operator,
            OperatorReplyIdentity {
                identity_profile: resolved_identity_profile(policy, &address)?,
                public_address: address.clone(),
            },
        );
        decision.allowed_reply_identities.push(address);
    }
    decision.allowed_reply_identities.sort();
    decision.allowed_reply_identities.dedup();
    Ok(decision)
}
