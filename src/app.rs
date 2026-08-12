use leptos::{ev::SubmitEvent, prelude::*};
use leptos_meta::{provide_meta_context, Meta, MetaTags, Title};
use leptos_router::{
    components::{Route, Router, Routes, A},
    hooks::use_params_map,
    ParamSegment, SsrMode, StaticSegment, WildcardSegment,
};

use crate::api::{
    load_desk, load_thread, DeskSnapshot, QueueReply, RouteHealthSummary, ThreadDetail,
};

#[allow(dead_code)]
pub fn shell(options: LeptosOptions) -> impl IntoView {
    #[cfg(feature = "ssr")]
    crate::install_render_content_security_policy();

    view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8"/>
                <meta name="viewport" content="width=device-width, initial-scale=1"/>
                <link rel="icon" href="/favicon.svg" type="image/svg+xml"/>
                <link rel="manifest" href="/site.webmanifest"/>
                <meta name="theme-color" content="#171914"/>
                <AutoReload options=options.clone()/>
                <HashedStylesheet options=options.clone()/>
                <EdgeHydrationScripts options=options/>
                <MetaTags/>
            </head>
            <body>
                <App/>
            </body>
        </html>
    }
}

#[component]
pub fn App() -> impl IntoView {
    provide_meta_context();

    view! {
        <Title text="maildesk-cf — Edge mail, proven"/>
        <Meta
            name="description"
            content="A Cloudflare-native mail desk where Rust policy chooses the route, operators preserve domain identity, and cfctl proves the edge state."
        />

        <Router>
            <Routes fallback=|| view! { <NotFoundPage/> }.into_view()>
                <Route path=StaticSegment("") view=HomePage ssr=SsrMode::OutOfOrder/>
                <Route
                    path=StaticSegment("architecture")
                    view=ArchitecturePage
                    ssr=SsrMode::OutOfOrder
                />
                <Route path=StaticSegment("desk") view=DeskPage ssr=SsrMode::OutOfOrder/>
                <Route
                    path=(
                        StaticSegment("desk"),
                        StaticSegment("thread"),
                        ParamSegment("id"),
                    )
                    view=ThreadPage
                    ssr=SsrMode::OutOfOrder
                />
                <Route path=WildcardSegment("any") view=NotFoundPage ssr=SsrMode::OutOfOrder/>
            </Routes>
        </Router>
    }
}

#[component]
fn SiteHeader(active: &'static str) -> impl IntoView {
    view! {
        <header class="site-header">
            <A href="/" attr:class="brand" attr:aria-label="maildesk-cf home">
                <span class="brand-mark" aria-hidden="true">
                    <span></span>
                    <span></span>
                </span>
                <span>"maildesk"<i>"·cf"</i></span>
            </A>
            <nav class="site-nav" aria-label="Primary navigation">
                <A href="/architecture" attr:aria-current=move || (active == "architecture").then_some("page")>
                    "Architecture"
                </A>
                <A href="/desk" attr:class="nav-action" attr:aria-current=move || (active == "desk").then_some("page")>
                    "Open the desk"
                    <span aria-hidden="true">"↗"</span>
                </A>
            </nav>
        </header>
    }
}

#[component]
fn HomePage() -> impl IntoView {
    view! {
        <div class="site-frame">
            <SiteHeader active="home"/>
            <main>
                <section class="hero-section" aria-labelledby="hero-title">
                    <div class="hero-copy">
                        <p class="eyebrow"><span></span>"Cloudflare-native shared mail"</p>
                        <h1 id="hero-title">
                            "Route at the edge."
                            <em>"Reply with the right identity."</em>
                            "Prove every step."
                        </h1>
                        <p class="hero-lede">
                            "maildesk-cf turns Email Routing, Rust policy, D1, R2, Queues, and governed Cloudflare state into one calm operator workflow."
                        </p>
                        <div class="hero-actions">
                            <A href="/desk" attr:class="button button--primary">
                                "Open the desk" <span aria-hidden="true">"↗"</span>
                            </A>
                            <A href="/architecture" attr:class="text-link">
                                "Read the architecture" <span aria-hidden="true">"→"</span>
                            </A>
                        </div>
                    </div>

                    <RouteInstrument/>
                </section>

                <section class="statement-section" aria-labelledby="statement-title">
                    <p class="section-index">"01 / The difference"</p>
                    <div>
                        <h2 id="statement-title">"A chain of custody, not another inbox skin."</h2>
                        <p>
                            "The router decides where mail belongs. The desk makes that decision legible. The server authorizes the reply identity. The audit trail records what actually happened."
                        </p>
                    </div>
                </section>

                <EvidencePlanes/>

                <section class="principles-section" aria-labelledby="principles-title">
                    <div class="section-heading">
                        <p class="section-index">"03 / Product rules"</p>
                        <h2 id="principles-title">"Boring where trust is expensive."</h2>
                    </div>
                    <div class="principle-grid">
                        <article>
                            <span>"A"</span>
                            <h3>"Policy before provider glue"</h3>
                            <p>"Rust owns alias matching, operator selection, and reply authorization. Workers adapt; they do not invent policy."</p>
                        </article>
                        <article>
                            <span>"B"</span>
                            <h3>"Identity before send"</h3>
                            <p>"The selected From identity stays visible at the protected action—not buried in settings or inferred after delivery."</p>
                        </article>
                        <article>
                            <span>"C"</span>
                            <h3>"Evidence before reassurance"</h3>
                            <p>"Source intent, local proof, deployment, and live readback remain separate so a green build never masquerades as mail readiness."</p>
                        </article>
                    </div>
                </section>

                <section class="closing-section">
                    <div>
                        <p class="eyebrow"><span></span>"Operator experience"</p>
                        <h2>"See what needs attention. Know what is safe to do next."</h2>
                    </div>
                    <A href="/desk" attr:class="button button--light">
                        "Open the desk" <span aria-hidden="true">"↗"</span>
                    </A>
                </section>
            </main>
            <SiteFooter/>
        </div>
    }
}

#[component]
fn RouteInstrument() -> impl IntoView {
    let stages = [
        ("01", "Edge", "Envelope accepted"),
        ("02", "Policy", "Role alias matched"),
        ("03", "Store", "Metadata + raw MIME"),
        ("04", "Desk", "Operator authorized"),
        ("05", "Send", "Identity verified"),
    ];

    view! {
        <aside class="route-instrument" aria-label="Illustrative mail chain of custody">
            <div class="instrument-head">
                <div>
                    <span class="live-dot"></span>
                    <span>"Chain of custody"</span>
                </div>
                <code>"example.com"</code>
            </div>
            <div class="route-line" aria-hidden="true"><span></span></div>
            <ol>
                {stages.into_iter().map(|(index, title, detail)| view! {
                    <li>
                        <span class="stage-index">{index}</span>
                        <div>
                            <strong>{title}</strong>
                            <small>{detail}</small>
                        </div>
                        <i aria-hidden="true"></i>
                    </li>
                }).collect_view()}
            </ol>
            <div class="instrument-foot">
                <span>"Illustrative template flow"</span>
                <span>"No live mail shown"</span>
            </div>
        </aside>
    }
}

#[component]
fn EvidencePlanes() -> impl IntoView {
    let planes = [
        ("Template", "Source + local proof", "Buildable and scrubbed"),
        (
            "Instance",
            "Private configuration",
            "Policy and bindings validate",
        ),
        (
            "Edge",
            "Deployment + readback",
            "Workers and resources match",
        ),
        (
            "Mail",
            "Targeted end-to-end proof",
            "Route through audited reply",
        ),
    ];

    view! {
        <section class="evidence-section" aria-labelledby="evidence-title">
            <div class="section-heading">
                <p class="section-index">"02 / Proof planes"</p>
                <h2 id="evidence-title">"Ready is not one thing."</h2>
                <p>"Each plane answers a different operational question. None inherits proof from the one before it."</p>
            </div>
            <ol class="evidence-grid">
                {planes.into_iter().enumerate().map(|(position, (title, source, detail))| view! {
                    <li>
                        <span class="plane-number">{format!("0{}", position + 1)}</span>
                        <h3>{title}</h3>
                        <p>{source}</p>
                        <small>{detail}</small>
                    </li>
                }).collect_view()}
            </ol>
        </section>
    }
}

#[component]
fn ArchitecturePage() -> impl IntoView {
    view! {
        <div class="site-frame">
            <SiteHeader active="architecture"/>
            <main class="document-page">
                <header class="document-hero">
                    <p class="eyebrow"><span></span>"Architecture"</p>
                    <h1>"One message. Six explicit boundaries."</h1>
                    <p>"maildesk-cf keeps policy, provider events, queryable state, opaque artifacts, asynchronous work, and account authority separate enough to test and prove."</p>
                </header>

                <section class="architecture-map" aria-label="Maildesk system map">
                    <div class="map-spine" aria-hidden="true"></div>
                    <article><span>"01"</span><h2>"Email Routing"</h2><p>"Cloudflare receives the envelope and invokes a bounded Email Worker adapter."</p><code>"attacker-controlled envelope + MIME"</code></article>
                    <article><span>"02"</span><h2>"Rust router"</h2><p>"Typed policy resolves domain, alias, operators, and the default reply identity."</p><code>"fail closed on unknown or unauthorized"</code></article>
                    <article><span>"03"</span><h2>"D1 + R2"</h2><p>"D1 stores queryable thread and audit metadata. R2 stores raw MIME and attachment blobs."</p><code>"metadata ≠ raw content"</code></article>
                    <article><span>"04"</span><h2>"Queues"</h2><p>"Parsing, notification, indexing, and outbound attempts move asynchronously with audit evidence."</p><code>"queued ≠ delivered"</code></article>
                    <article><span>"05"</span><h2>"Operator desk"</h2><p>"An authenticated operator sees bounded state and the policy-selected identity before the reply gate."</p><code>"identity before action"</code></article>
                    <article><span>"06"</span><h2>"cfctl"</h2><p>"Account reads, plans, applies, and post-change verification stay outside the runtime."</p><code>"source ≠ live Cloudflare state"</code></article>
                </section>

                <section class="architecture-cta">
                    <p>"The UI can change. The router and evidence boundaries are the product spine."</p>
                    <A href="/desk" attr:class="button button--primary">"Open the desk" <span aria-hidden="true">"↗"</span></A>
                </section>
            </main>
            <SiteFooter/>
        </div>
    }
}

#[component]
fn DeskPage() -> impl IntoView {
    let refresh = RwSignal::new(0_usize);
    let snapshot = Resource::new(move || refresh.get(), |_| async move { load_desk().await });

    view! {
        <Suspense fallback=move || view! { <DeskLoading/> }>
            {move || match snapshot.get() {
                None => view! { <DeskLoading/> }.into_any(),
                Some(Err(error)) => view! {
                    <DeskFailure message=user_facing_server_error(error.to_string()) refresh=refresh/>
                }.into_any(),
                Some(Ok(data)) => view! {
                    <DeskLoaded data=data refresh=refresh/>
                }.into_any(),
            }}
        </Suspense>
    }
}

#[component]
fn DeskLoading() -> impl IntoView {
    view! {
        <div class="desk-page desk-state-shell">
            <div class="loading-route" aria-live="polite">
                <span class="live-dot"></span>
                <p>"Loading the mail assigned to you…"</p>
            </div>
        </div>
    }
}

#[component]
fn DeskFailure(message: String, refresh: RwSignal<usize>) -> impl IntoView {
    view! {
        <div class="desk-page desk-state-shell">
            <section class="state-card" role="alert">
                <p class="eyebrow"><span></span>"Desk unavailable"</p>
                <h1>"Your desk could not be loaded."</h1>
                <p>{message}</p>
                <button class="button button--primary" type="button" on:click=move |_| refresh.update(|value| *value += 1)>
                    "Try again"
                </button>
            </section>
        </div>
    }
}

#[component]
fn DeskLoaded(data: DeskSnapshot, refresh: RwSignal<usize>) -> impl IntoView {
    let DeskSnapshot {
        operator,
        preview,
        threads,
        open_count,
        outbound_mode,
        operator_delivery_mode,
        routes,
    } = data;
    if operator_delivery_mode == "inbox_relay" {
        return view! {
            <RoutingHealthDashboard operator=operator preview=preview routes=routes refresh=refresh/>
        }
        .into_any();
    }
    let thread_count = threads.len();
    let has_threads = !threads.is_empty();
    let initials = operator
        .split(['@', '.', '-', '_'])
        .filter_map(|part| part.chars().next())
        .take(2)
        .collect::<String>()
        .to_uppercase();
    let mode_label = if outbound_mode == "disabled" {
        "Receive-only"
    } else {
        "Policy-gated send"
    };

    view! {
        <div class="desk-page">
            <header class="desk-topbar">
                <A href="/" attr:class="brand brand--desk" attr:aria-label="maildesk-cf home">
                    <span class="brand-mark" aria-hidden="true"><span></span><span></span></span>
                    <span>"maildesk"<i>"·cf"</i></span>
                </A>
                <div class="desk-environment">
                    <span class:preview-badge=preview class:live-badge=move || !preview>
                        {if preview { "Template preview" } else { "Access protected" }}
                    </span>
                    <span>{mode_label}</span>
                </div>
                <div class="operator-pill">
                    <span>{initials}</span>
                    <div><strong>"Operator"</strong><small>{operator}</small></div>
                </div>
            </header>

            <main class="desk-shell">
                <aside class="desk-sidebar">
                    <nav aria-label="Desk navigation">
                        <a class="desk-nav-item desk-nav-item--active" href="#attention"><span>"Attention"</span><b>{open_count}</b></a>
                        <a class="desk-nav-item" href="#readiness"><span>"Readiness"</span><b>"4"</b></a>
                        <a class="desk-nav-item" href="#activity"><span>"Audit activity"</span><b>"→"</b></a>
                    </nav>
                    <div class="sidebar-note">
                        <span>"Outbound"</span>
                        <strong>{mode_label}</strong>
                        <p>{if outbound_mode == "disabled" { "Receive-only is a valid posture—not an error." } else { "Every reply still passes identity authorization before Queue submission." }}</p>
                    </div>
                </aside>

                <section class="desk-workspace" id="attention">
                    <header class="workspace-head">
                        <div>
                            <p class="eyebrow"><span></span>"Operator desk"</p>
                            <h1>{if open_count == 0 { "Nothing needs attention." } else { "Mail needs your judgment." }}</h1>
                            <p>{if preview { "This state is intentionally empty: the public template never presents invented messages as production data." } else { "Only threads assigned to the authenticated Access identity appear here." }}</p>
                        </div>
                        <button class="button button--quiet" type="button" on:click=move |_| refresh.update(|value| *value += 1)>
                            "Refresh desk"
                        </button>
                    </header>

                    <div class="desk-grid">
                        <section class="thread-panel" aria-labelledby="thread-list-title">
                            <div class="panel-title">
                                <div><span>{format!("{thread_count:02}")}</span><h2 id="thread-list-title">"Attention queue"</h2></div>
                                <small>{if preview { "No authenticated projection" } else { "Operator scoped" }}</small>
                            </div>
                            {if has_threads {
                                view! {
                                    <ol class="thread-list">
                                        {threads.into_iter().map(|thread| {
                                            let href = format!("/desk/thread/{}", thread.id);
                                            view! {
                                                <li>
                                                    <A href=href attr:class="thread-row">
                                                        <div class="thread-status" data-status=thread.status.clone()></div>
                                                        <div class="thread-copy">
                                                            <span>{thread.external_sender}</span>
                                                            <strong>{thread.subject}</strong>
                                                            <small>{thread.route_address}" · "{thread.message_count}" messages"</small>
                                                        </div>
                                                        <time>{thread.updated_at}</time>
                                                        <span aria-hidden="true">"→"</span>
                                                    </A>
                                                </li>
                                            }
                                        }).collect_view()}
                                    </ol>
                                }.into_any()
                            } else {
                                view! {
                                    <div class="desk-empty">
                                        <div class="empty-glyph" aria-hidden="true"><span></span><span></span><span></span></div>
                                        <h3>"The queue is quiet."</h3>
                                        <p>{if preview { "Connect a private instance to replace this state with real operator-scoped mail." } else { "No open or closed threads are assigned to this operator." }}</p>
                                        <A href="/architecture" attr:class="text-link">"Review the data boundary" <span aria-hidden="true">"→"</span></A>
                                    </div>
                                }.into_any()
                            }}
                        </section>

                        <aside class="evidence-panel" id="readiness" aria-labelledby="readiness-title">
                            <div class="panel-title">
                                <div><span>"04"</span><h2 id="readiness-title">"Readiness planes"</h2></div>
                                <small>{if preview { "Source view" } else { "Runtime view" }}</small>
                            </div>
                            <EvidenceRow name="Template" state="Local proof is independent" tone="neutral"/>
                            <EvidenceRow name="Instance" state=if preview { "Private configuration required" } else { "Desk database resolved" } tone="neutral"/>
                            <EvidenceRow name="Edge" state="Live readback required" tone="attention"/>
                            <EvidenceRow name="Mail" state="Targeted proof required" tone="attention"/>
                            <div class="evidence-note">
                                <strong>"Why the labels matter"</strong>
                                <p>"A build can pass while the account is unconfigured. A Worker can deploy while mail delivery remains unproven."</p>
                            </div>
                        </aside>
                    </div>

                    <section class="audit-strip" id="activity">
                        <div><span class="audit-icon">"↳"</span><p><strong>"Audit follows the thread."</strong> "Authorization, queue attempt, provider result, and delivery remain distinct events."</p></div>
                        <time>{if preview { "No live evidence" } else { "Open a thread" }}</time>
                    </section>
                </section>
            </main>
        </div>
    }.into_any()
}

#[component]
fn RoutingHealthDashboard(
    operator: String,
    preview: bool,
    routes: Vec<RouteHealthSummary>,
    refresh: RwSignal<usize>,
) -> impl IntoView {
    let exception_count = routes
        .iter()
        .filter(|route| route_needs_attention(route))
        .count();
    let ready_count = routes
        .iter()
        .filter(|route| {
            route.inbound_status == "inbox_verified" && route.reply_status == "reply_verified"
        })
        .count();
    let route_count = routes.len();

    view! {
        <div class="desk-page">
            <header class="desk-topbar">
                <A href="/" attr:class="brand brand--desk" attr:aria-label="maildesk-cf home">
                    <span class="brand-mark" aria-hidden="true"><span></span><span></span></span>
                    <span>"maildesk"<i>"·cf"</i></span>
                </A>
                <div class="desk-environment">
                    <span class:preview-badge=preview class:live-badge=move || !preview>
                        {if preview { "Template preview" } else { "Access protected" }}
                    </span>
                    <span>"Inbox relay · routing only"</span>
                </div>
                <div class="operator-pill"><div><strong>"Operator"</strong><small>{operator}</small></div></div>
            </header>
            <main class="desk-shell">
                <aside class="desk-sidebar">
                    <nav aria-label="Routing navigation">
                        <a class="desk-nav-item desk-nav-item--active" href="#routes"><span>"Declared routes"</span><b>{route_count}</b></a>
                        <a class="desk-nav-item" href="#exceptions"><span>"Exceptions"</span><b>{exception_count}</b></a>
                        <a class="desk-nav-item" href="#proof"><span>"Mail-ready"</span><b>{ready_count}</b></a>
                    </nav>
                    <div class="sidebar-note">
                        <span>"Product boundary"</span>
                        <strong>"No message content"</strong>
                        <p>"This surface shows declared configuration and evidence state. Read and reply to routed mail in the existing operator inbox."</p>
                    </div>
                </aside>
                <section class="desk-workspace" id="routes">
                    <header class="workspace-head">
                        <div>
                            <p class="eyebrow"><span></span>"Routing health"</p>
                            <h1>{if exception_count == 0 { "Routes are declared. Proof remains explicit." } else { "Mail routes need attention." }}</h1>
                            <p>"Provider acceptance, inbox receipt, and external reply receipt are independent states. Nothing becomes mail-ready from deployment alone."</p>
                        </div>
                        <button class="button button--quiet" type="button" on:click=move |_| refresh.update(|value| *value += 1)>"Refresh routes"</button>
                    </header>
                    <section class="thread-panel" id="exceptions" aria-labelledby="route-health-title">
                        <div class="panel-title"><div><span>{format!("{route_count:02}")}</span><h2 id="route-health-title">"Domain and alias health"</h2></div><small>"Body-free metadata"</small></div>
                        {if routes.is_empty() {
                            view! { <div class="desk-empty"><h3>"No routes have been projected."</h3><p>"Run the policy-sync command against a migrated local D1 database before deployment planning."</p></div> }.into_any()
                        } else {
                            view! {
                                <ol class="thread-list">
                                    {routes.into_iter().map(|route| {
                                        let needs_attention = route_needs_attention(&route);
                                        let observed = route.observed_provider.clone().unwrap_or_else(|| "unobserved".to_string());
                                        let last_proof = route.last_reply_at.clone().or(route.last_inbound_at.clone()).unwrap_or_else(|| "No proof recorded".to_string());
                                        let next = next_route_action(&route);
                                        view! {
                                            <li>
                                                <article class="thread-row" id="proof">
                                                    <div class="thread-status" data-status=if needs_attention { "open" } else { "closed" }></div>
                                                    <div class="thread-copy">
                                                        <span>{route.decision_kind.clone()}" · "{route.operator_count}" destinations"</span>
                                                        <strong>{route.route_address.clone()}</strong>
                                                        <small>"Reply as "{route.reply_identity.clone()}</small>
                                                        <small>"Desired "{route.desired_provider.clone()}" · observed "{observed}</small>
                                                        <small>"Inbound "{route.inbound_status.clone()}" · reply "{route.reply_status.clone()}</small>
                                                        <small>"Next: "{next}</small>
                                                    </div>
                                                    <time>{last_proof}</time>
                                                </article>
                                            </li>
                                        }
                                    }).collect_view()}
                                </ol>
                            }.into_any()
                        }}
                    </section>
                </section>
            </main>
        </div>
    }
}

fn route_needs_attention(route: &RouteHealthSummary) -> bool {
    matches!(
        route.inbound_status.as_str(),
        "partial_delivery" | "recovery_required" | "failed"
    ) || matches!(
        route.reply_status.as_str(),
        "partial_delivery" | "recovery_required" | "failed"
    )
}

fn next_route_action(route: &RouteHealthSummary) -> &'static str {
    if route_needs_attention(route) {
        "Reconcile the bounded failure before retrying"
    } else if route.inbound_status == "intentionally_excluded" {
        "No action; route is intentionally excluded"
    } else if route.inbound_status == "declared" || route.inbound_status == "local_policy_valid" {
        "Verify edge bindings and provider state"
    } else if route.inbound_status != "inbox_verified" {
        "Record a targeted inbox receipt"
    } else if route.reply_status != "reply_verified" {
        "Record a targeted external reply receipt"
    } else {
        "Maintain proof freshness"
    }
}

#[component]
fn EvidenceRow(name: &'static str, state: &'static str, tone: &'static str) -> impl IntoView {
    view! {
        <div class=format!("evidence-row evidence-row--{tone}")>
            <span class="evidence-state" aria-hidden="true"></span>
            <div><strong>{name}</strong><small>{state}</small></div>
            <span aria-hidden="true">"→"</span>
        </div>
    }
}

#[component]
fn ThreadPage() -> impl IntoView {
    let params = use_params_map();
    let id = move || {
        params
            .read()
            .get("id")
            .unwrap_or_else(|| "unknown".to_string())
    };
    let refresh = RwSignal::new(0_usize);
    let thread = Resource::new(
        move || (id(), refresh.get()),
        |(thread_id, _)| async move { load_thread(thread_id).await },
    );

    view! {
        <Suspense fallback=move || view! { <DeskLoading/> }>
            {move || match thread.get() {
                None => view! { <DeskLoading/> }.into_any(),
                Some(Err(error)) => view! {
                    <div class="site-frame">
                        <SiteHeader active="desk"/>
                        <main class="state-page">
                            <p class="eyebrow"><span></span>"Protected thread route"</p>
                            <h1>"This thread is unavailable."</h1>
                            <p>{user_facing_server_error(error.to_string())}</p>
                            <A href="/desk" attr:class="button button--primary">"Return to the desk"</A>
                        </main>
                        <SiteFooter/>
                    </div>
                }.into_any(),
                Some(Ok(data)) => view! { <ThreadLoaded data=data refresh=refresh/> }.into_any(),
            }}
        </Suspense>
    }
}

#[component]
fn ThreadLoaded(data: ThreadDetail, refresh: RwSignal<usize>) -> impl IntoView {
    let thread_id = data.thread.id.clone();
    let can_reply = data.outbound_mode != "disabled";
    let from_identity = RwSignal::new(
        data.allowed_reply_identities
            .first()
            .cloned()
            .unwrap_or_default(),
    );
    let subject = RwSignal::new(format!("Re: {}", data.thread.subject));
    let body = RwSignal::new(String::new());
    let local_error = RwSignal::new(None::<String>);
    let reply_action = ServerAction::<QueueReply>::new();

    let on_submit = move |event: SubmitEvent| {
        event.prevent_default();
        let subject_value = subject.get_untracked();
        let body_value = body.get_untracked();
        if let Some(message) = reply_form_error(&subject_value, &body_value) {
            local_error.set(Some(message.to_string()));
            return;
        }
        local_error.set(None);
        reply_action.dispatch(QueueReply {
            thread_id: thread_id.clone(),
            from_identity: from_identity.get_untracked(),
            subject: subject_value,
            body: body_value,
        });
    };
    let action_error = move || {
        reply_action
            .value()
            .get()
            .and_then(|result| result.err().map(|error| error.to_string()))
    };

    view! {
        <div class="thread-page">
            <header class="desk-topbar">
                <A href="/desk" attr:class="brand brand--desk" attr:aria-label="Return to maildesk">
                    <span class="brand-mark" aria-hidden="true"><span></span><span></span></span>
                    <span>"maildesk"<i>"·cf"</i></span>
                </A>
                <div class="desk-environment"><span class="live-badge">"Protected thread"</span><span>{data.thread.route_address.clone()}</span></div>
                <button class="button button--quiet" type="button" on:click=move |_| refresh.update(|value| *value += 1)>"Refresh"</button>
            </header>
            <main class="thread-shell">
                <aside class="thread-summary">
                    <A href="/desk" attr:class="text-link">"← Attention queue"</A>
                    <p class="eyebrow"><span></span>{data.thread.status.clone()}</p>
                    <h1>{data.thread.subject.clone()}</h1>
                    <dl>
                        <div><dt>"From"</dt><dd>{data.thread.external_sender.clone()}</dd></div>
                        <div><dt>"Route"</dt><dd>{data.thread.route_address.clone()}</dd></div>
                        <div><dt>"Messages"</dt><dd>{data.thread.message_count}</dd></div>
                        <div><dt>"Updated"</dt><dd>{data.thread.updated_at.clone()}</dd></div>
                    </dl>
                </aside>

                <section class="thread-timeline" aria-labelledby="timeline-title">
                    <div class="panel-title"><div><span>{format!("{:02}", data.messages.len())}</span><h2 id="timeline-title">"Envelope timeline"</h2></div><small>"Metadata only"</small></div>
                    <ol>
                        {data.messages.into_iter().map(|message| view! {
                            <li>
                                <span class=format!("message-direction message-direction--{}", message.direction)></span>
                                <div><strong>{message.envelope_from}" → "{message.envelope_to}</strong><small>{message.direction}" · "{message.created_at}</small></div>
                            </li>
                        }).collect_view()}
                    </ol>
                    <p class="timeline-boundary">"Raw MIME remains in R2. This surface exposes only operator-scoped D1 metadata until a reviewed parser and content policy are present."</p>
                </section>

                <aside class="reply-panel">
                    <div class="panel-title"><div><span>"→"</span><h2>"Authorized reply"</h2></div><small>"Identity before send"</small></div>
                    <form on:submit=on_submit>
                        <label for="reply-from">"From identity"</label>
                        <output id="reply-from" class="identity-value" aria-describedby="reply-identity-help">{move || from_identity.get()}</output>
                        <p id="reply-identity-help" class="field-help">"Policy authorizes this identity for the current route and operator."</p>
                        <label for="reply-subject">"Subject"</label>
                        <input id="reply-subject" type="text" maxlength="240" required prop:value=move || subject.get() on:input=move |event| subject.set(event_target_value(&event))/>
                        <label for="reply-body">"Reply"</label>
                        <textarea id="reply-body" rows="10" maxlength="24000" required prop:value=move || body.get() on:input=move |event| body.set(event_target_value(&event)) placeholder="Write a clear, bounded reply…" disabled=!can_reply></textarea>
                        <Show when=move || !can_reply>
                            <p class="form-feedback">"This instance is receive-only. Configure and verify an outbound provider before replies can be queued."</p>
                        </Show>
                        <Show when=move || local_error.get().is_some() || action_error().is_some()>
                            <p class="form-feedback form-feedback--error" role="alert">{move || local_error.get().or_else(action_error).unwrap_or_default()}</p>
                        </Show>
                        <Show when=move || matches!(reply_action.value().get(), Some(Ok(_)))>
                            <p class="form-feedback form-feedback--success" role="status">"Reply authorized and queued. Delivery remains a separate audit event."</p>
                        </Show>
                        <button class="button button--primary" type="submit" disabled=move || !can_reply || reply_action.pending().get()>
                            {move || if reply_action.pending().get() { "Authorizing…" } else { "Authorize & queue reply" }}
                        </button>
                    </form>
                    <div class="reply-proof"><span>"Policy gate"</span><p>"The server rebuilds the route decision from operator-scoped D1 state and calls the Rust router before Queue submission."</p></div>
                </aside>

                <section class="thread-audit">
                    <div class="panel-title"><div><span>{format!("{:02}", data.audit.len())}</span><h2>"Audit evidence"</h2></div><small>"Newest first"</small></div>
                    <ol>{data.audit.into_iter().map(|event| view! { <li><strong>{event.action}</strong><span>{event.actor}</span><time>{event.created_at}</time></li> }).collect_view()}</ol>
                </section>
            </main>
        </div>
    }
}

fn reply_form_error(subject: &str, body: &str) -> Option<&'static str> {
    if subject.trim().is_empty() {
        return Some("Add a subject before the reply can be authorized and queued.");
    }
    if body.trim().is_empty() {
        return Some("Write a reply before it can be authorized and queued.");
    }
    None
}

fn user_facing_server_error(message: String) -> String {
    message
        .strip_prefix("error running server function: ")
        .unwrap_or(&message)
        .to_string()
}

#[component]
fn NotFoundPage() -> impl IntoView {
    view! {
        <div class="site-frame">
            <SiteHeader active="none"/>
            <main class="state-page">
                <p class="eyebrow"><span></span>"404 / Route not found"</p>
                <h1>"This path left the mail route."</h1>
                <p>"Nothing was changed. Return to the product overview or open the operator desk."</p>
                <div class="hero-actions">
                    <A href="/" attr:class="button button--primary">"Return home"</A>
                    <A href="/desk" attr:class="text-link">"Open the desk" <span aria-hidden="true">"→"</span></A>
                </div>
            </main>
            <SiteFooter/>
        </div>
    }
}

#[component]
fn SiteFooter() -> impl IntoView {
    view! {
        <footer class="site-footer">
            <p>"maildesk-cf" <span>"/"</span> "Edge mail, proven."</p>
            <p>"Rust policy · Cloudflare runtime · cfctl authority"</p>
        </footer>
    }
}

#[component]
fn HashedStylesheet(options: LeptosOptions) -> impl IntoView {
    let href = asset_href(&options, "css", crate::asset_hashes::CSS_HASH);
    view! { <link id="leptos" rel="stylesheet" href=href/> }
}

#[component]
fn EdgeHydrationScripts(options: LeptosOptions) -> impl IntoView {
    let js_href = asset_href(&options, "js", crate::asset_hashes::JS_HASH);
    let wasm_href = asset_href(&options, "wasm", crate::asset_hashes::WASM_HASH);
    let hydration_script = format!(
        "import({js_href:?}).then(mod => {{ mod.default({{ module_or_path: {wasm_href:?} }}).then(() => {{ mod.hydrate(); }}); }});"
    );
    #[cfg(feature = "ssr")]
    let nonce = leptos::nonce::use_nonce().map(|value| value.to_string());
    #[cfg(not(feature = "ssr"))]
    let nonce = None::<String>;

    view! {
        <link rel="modulepreload" href=js_href.clone()/>
        <link rel="preload" href=wasm_href.clone() r#as="fetch" r#type="application/wasm"/>
        <script type="module" nonce=nonce>{hydration_script}</script>
    }
}

fn asset_href(options: &LeptosOptions, extension: &str, hash: &str) -> String {
    let output_name = options.output_name.as_ref();
    let output_name = if output_name.is_empty() {
        env!("CARGO_PKG_NAME")
    } else {
        output_name
    };
    let pkg_dir = options.site_pkg_dir.as_ref();

    if hash.is_empty() {
        format!("/{pkg_dir}/{output_name}.{extension}")
    } else {
        format!("/{pkg_dir}/{output_name}.{hash}.{extension}")
    }
}

#[cfg(test)]
mod tests {
    use super::{reply_form_error, user_facing_server_error};

    #[test]
    fn reply_form_feedback_names_the_missing_action() {
        assert_eq!(
            reply_form_error(" ", "A reply"),
            Some("Add a subject before the reply can be authorized and queued.")
        );
        assert_eq!(
            reply_form_error("Re: question", " "),
            Some("Write a reply before it can be authorized and queued.")
        );
        assert_eq!(reply_form_error("Re: question", "A reply"), None);
    }

    #[test]
    fn server_errors_hide_framework_language_from_operators() {
        assert_eq!(
            user_facing_server_error(
                "error running server function: Thread data is unavailable.".to_string()
            ),
            "Thread data is unavailable."
        );
        assert_eq!(
            user_facing_server_error("A direct message.".to_string()),
            "A direct message."
        );
    }
}
