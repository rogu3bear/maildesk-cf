mod api;
mod app;
mod asset_hashes;
#[cfg(feature = "ssr")]
mod server;

#[cfg(feature = "hydrate")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn hydrate() {
    console_error_panic_hook::set_once();
    leptos::mount::hydrate_body(app::App);
}

#[cfg(feature = "ssr")]
#[worker::event(fetch)]
async fn fetch(
    req: worker::HttpRequest,
    env: worker::Env,
    _ctx: worker::Context,
) -> worker::Result<axum::http::Response<axum::body::Body>> {
    use axum::body::Body;
    use axum::extract::DefaultBodyLimit;
    use axum::http::{Response, StatusCode};
    use axum::Router;
    use leptos::prelude::*;
    use leptos_axum::{generate_route_list, LeptosRoutes};
    use tower_service::Service;

    let conf =
        get_configuration(None).map_err(|error| worker::Error::RustError(error.to_string()))?;
    let leptos_options = conf.leptos_options;
    let fallback_content_security_policy = content_security_policy(None)?;

    let operator_access = match operator_access(&req, &env) {
        Ok(access) => access,
        Err(rejection) => {
            let mut response = Response::builder()
                .status(rejection.status)
                .header("content-type", "text/plain; charset=utf-8")
                .body(Body::from(rejection.message))
                .map_err(|error| worker::Error::RustError(error.to_string()))?;
            apply_response_headers(&mut response, &fallback_content_security_policy)?;
            return Ok(response);
        }
    };

    let routes = generate_route_list(app::App);
    let state = server::AppState::new(
        leptos_options.clone(),
        env,
        operator_access.operator,
        operator_access.preview,
    );
    let context_state = state.clone();
    let mut router = Router::new()
        .layer(DefaultBodyLimit::max(32 * 1024))
        .leptos_routes_with_context(
            &state,
            routes,
            move || provide_context(context_state.clone()),
            {
                let leptos_options = leptos_options.clone();
                move || app::shell(leptos_options.clone())
            },
        )
        .with_state(state);

    let mut response = router.call(req).await?;
    if response.status() == StatusCode::NOT_FOUND {
        response.headers_mut().insert(
            axum::http::header::HeaderName::from_static("x-maildesk-route"),
            axum::http::header::HeaderValue::from_static("not-found"),
        );
    }
    apply_response_headers(&mut response, &fallback_content_security_policy)?;
    Ok(response)
}

#[cfg(feature = "ssr")]
struct AccessRejection {
    status: axum::http::StatusCode,
    message: &'static str,
}

#[cfg(feature = "ssr")]
struct OperatorAccess {
    operator: Option<String>,
    preview: bool,
}

#[cfg(feature = "ssr")]
fn operator_access(
    req: &worker::HttpRequest,
    env: &worker::Env,
) -> Result<OperatorAccess, AccessRejection> {
    use axum::http::StatusCode;

    if !is_desk_path(req.uri().path()) {
        return Ok(OperatorAccess {
            operator: None,
            preview: false,
        });
    }

    let mode = env
        .var("MAILDESK_UI_AUTH_MODE")
        .ok()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "access".to_string());

    if mode == "preview" {
        return Ok(OperatorAccess {
            operator: Some("operator@example.com".to_string()),
            preview: true,
        });
    }

    if mode != "access" {
        return Err(AccessRejection {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "The operator desk authentication mode is invalid.",
        });
    }

    let email = req
        .headers()
        .get("cf-access-authenticated-user-email")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let assertion = req
        .headers()
        .get("cf-access-jwt-assertion")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let validated = req
        .headers()
        .get("x-maildesk-access-validated")
        .and_then(|value| value.to_str().ok())
        == Some("1");

    if let Some(email) = verified_access_email(email, assertion, validated) {
        if req.uri().path().starts_with("/desk/api") && !same_origin_desk_api_request(req) {
            return Err(AccessRejection {
                status: StatusCode::FORBIDDEN,
                message: "Cross-origin operator requests are not allowed.",
            });
        }
        Ok(OperatorAccess {
            operator: Some(email.to_lowercase()),
            preview: false,
        })
    } else {
        Err(AccessRejection {
            status: StatusCode::UNAUTHORIZED,
            message: "Cloudflare Access authentication is required for the operator desk.",
        })
    }
}

#[cfg(feature = "ssr")]
fn same_origin_desk_api_request(req: &worker::HttpRequest) -> bool {
    use axum::http::Method;

    let fetch_site = req
        .headers()
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok())
        .map(str::trim);
    same_origin_desk_api_policy(req.method() == Method::POST, fetch_site)
}

#[cfg(any(feature = "ssr", test))]
fn same_origin_desk_api_policy(is_post: bool, fetch_site: Option<&str>) -> bool {
    !is_post || fetch_site == Some("same-origin")
}

#[cfg(any(feature = "ssr", test))]
fn verified_access_email<'a>(
    email: Option<&'a str>,
    assertion: Option<&str>,
    validated: bool,
) -> Option<&'a str> {
    (assertion.is_some() && validated)
        .then_some(email)
        .flatten()
}

#[cfg(any(feature = "ssr", test))]
fn is_desk_path(path: &str) -> bool {
    path == "/desk" || path.starts_with("/desk/")
}

#[cfg(feature = "ssr")]
fn apply_response_headers(
    response: &mut axum::http::Response<axum::body::Body>,
    content_security_policy: &axum::http::header::HeaderValue,
) -> worker::Result<()> {
    use axum::http::header::{
        HeaderName, HeaderValue, CACHE_CONTROL, REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS,
    };

    let headers = response.headers_mut();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(
        REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    let content_security_policy_name = HeaderName::from_static("content-security-policy");
    if !headers.contains_key(&content_security_policy_name) {
        headers.insert(
            content_security_policy_name,
            content_security_policy.clone(),
        );
    }
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=(), payment=()"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-opener-policy"),
        HeaderValue::from_static("same-origin"),
    );
    Ok(())
}

#[cfg(feature = "ssr")]
fn content_security_policy(nonce: Option<&str>) -> worker::Result<axum::http::header::HeaderValue> {
    let value = content_security_policy_value(nonce, cfg!(debug_assertions))
        .map_err(|message| worker::Error::RustError(message.to_string()))?;
    axum::http::header::HeaderValue::from_str(&value)
        .map_err(|error| worker::Error::RustError(error.to_string()))
}

#[cfg(any(feature = "ssr", test))]
fn content_security_policy_value(
    nonce: Option<&str>,
    allow_dev_connections: bool,
) -> Result<String, &'static str> {
    let script_sources = match nonce {
        Some(value)
            if !value.is_empty()
                && value.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                }) =>
        {
            format!("'self' 'nonce-{value}' 'wasm-unsafe-eval'")
        }
        Some(_) => return Err("Leptos produced an invalid CSP nonce."),
        None => "'none'".to_string(),
    };
    let connect_sources = if allow_dev_connections {
        "'self' ws: wss:"
    } else {
        "'self'"
    };
    Ok(format!(
        "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; connect-src {connect_sources}; style-src 'self'; script-src {script_sources};"
    ))
}

#[cfg(feature = "ssr")]
pub(crate) fn install_render_content_security_policy() {
    use axum::http::header::HeaderName;
    use leptos::context::use_context;

    let Some(nonce) = leptos::nonce::use_nonce() else {
        return;
    };
    let Some(response_options) = use_context::<leptos_axum::ResponseOptions>() else {
        return;
    };
    let Ok(value) = content_security_policy(Some(&nonce)) else {
        return;
    };
    response_options.insert_header(HeaderName::from_static("content-security-policy"), value);
}

#[cfg(test)]
mod tests {
    use super::{
        content_security_policy_value, is_desk_path, same_origin_desk_api_policy,
        verified_access_email,
    };

    #[test]
    fn rendered_csp_authorizes_only_the_response_nonce() {
        let result = content_security_policy_value(Some("safe_nonce-123"), false);
        assert!(result.is_ok());
        let Ok(value) = result else {
            return;
        };
        assert!(value.contains("script-src 'self' 'nonce-safe_nonce-123' 'wasm-unsafe-eval'"));
        assert!(!value.contains("'unsafe-inline'"));
        assert!(!value.contains("ws:"));
    }

    #[test]
    fn fallback_csp_fails_closed_without_a_render_nonce() {
        let result = content_security_policy_value(None, false);
        assert!(result.is_ok());
        let Ok(value) = result else {
            return;
        };
        assert!(value.contains("script-src 'none'"));
    }

    #[test]
    fn csp_rejects_nonce_source_injection() {
        assert!(content_security_policy_value(Some("bad' 'unsafe-inline"), false).is_err());
    }

    #[test]
    fn desk_path_boundary_does_not_capture_unrelated_routes() {
        assert!(is_desk_path("/desk"));
        assert!(is_desk_path("/desk/api/load"));
        assert!(!is_desk_path("/desktop"));
        assert!(!is_desk_path("/desk-preview"));
    }

    #[test]
    fn operator_mutations_require_same_origin_browser_context() {
        assert!(same_origin_desk_api_policy(true, Some("same-origin")));
        assert!(!same_origin_desk_api_policy(true, Some("same-site")));
        assert!(!same_origin_desk_api_policy(true, Some("cross-site")));
        assert!(!same_origin_desk_api_policy(true, None));
        assert!(same_origin_desk_api_policy(false, None));
    }

    #[test]
    fn access_header_presence_without_shim_validation_is_not_sufficient() {
        assert_eq!(
            verified_access_email(Some("operator@example.com"), Some("jwt"), false),
            None
        );
        assert_eq!(
            verified_access_email(Some("operator@example.com"), Some("jwt"), true),
            Some("operator@example.com")
        );
        assert_eq!(verified_access_email(None, Some("jwt"), true), None);
        assert_eq!(
            verified_access_email(Some("operator@example.com"), None, true),
            None
        );
    }
}
