use maildesk_router::{validate_policy, RouterPolicy};
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

    let route_count =
        validate_policy(&policy).map_err(|error| format!("invalid policy {path}: {error}"))?;

    println!("policy ok: {route_count} routes");
    Ok(())
}
