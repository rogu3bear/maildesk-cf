use std::sync::Arc;

use axum::extract::FromRef;
use leptos::prelude::LeptosOptions;

#[derive(Clone)]
pub struct AppState {
    pub leptos_options: LeptosOptions,
    pub env: Arc<worker::Env>,
    operator: Option<Arc<str>>,
    preview: bool,
}

impl AppState {
    pub fn new(
        leptos_options: LeptosOptions,
        env: worker::Env,
        operator: Option<String>,
        preview: bool,
    ) -> Self {
        Self {
            leptos_options,
            env: Arc::new(env),
            operator: operator.map(Arc::<str>::from),
            preview,
        }
    }

    pub fn db(&self) -> worker::Result<worker::D1Database> {
        self.env.d1("DB")
    }

    pub fn queue(&self) -> worker::Result<worker::Queue> {
        self.env.queue("MAIL_JOBS")
    }

    pub fn operator(&self) -> Option<&str> {
        self.operator.as_deref()
    }

    pub fn preview(&self) -> bool {
        self.preview
    }
}

impl FromRef<AppState> for LeptosOptions {
    fn from_ref(input: &AppState) -> Self {
        input.leptos_options.clone()
    }
}
