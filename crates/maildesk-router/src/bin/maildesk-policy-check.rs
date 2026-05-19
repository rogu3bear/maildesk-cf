use maildesk_router::{route_message, InboundMessage, RouterPolicy};
use std::{env, fs, process};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let path = env::args()
        .nth(1)
        .ok_or_else(|| "usage: maildesk-policy-check <policy.json>".to_string())?;

    let contents =
        fs::read_to_string(&path).map_err(|error| format!("failed to read {path}: {error}"))?;
    let policy: RouterPolicy = serde_json::from_str(&contents)
        .map_err(|error| format!("failed to parse {path}: {error}"))?;

    let mut route_count = 0usize;
    for (domain, domain_policy) in &policy.domains {
        for local_part in domain_policy.role_aliases.keys() {
            check_route(&policy, local_part, domain)?;
            route_count += 1;
        }

        for local_part in domain_policy.personal_aliases.keys() {
            check_route(&policy, local_part, domain)?;
            route_count += 1;
        }
    }

    if route_count == 0 {
        return Err("policy contains no routes".to_string());
    }

    println!("policy ok: {route_count} routes");
    Ok(())
}

fn check_route(policy: &RouterPolicy, local_part: &str, domain: &str) -> Result<(), String> {
    route_message(
        policy,
        &InboundMessage {
            envelope_to: format!("{local_part}@{domain}"),
            header_from: "sender@example.net".to_string(),
            message_id: None,
            subject: None,
        },
    )
    .map_err(|error| format!("invalid route {local_part}@{domain}: {error}"))?;

    Ok(())
}
