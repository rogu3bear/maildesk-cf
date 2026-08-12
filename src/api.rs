use leptos::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadSummary {
    pub id: String,
    pub subject: String,
    pub external_sender: String,
    pub status: String,
    pub updated_at: String,
    pub message_count: usize,
    pub route_address: String,
    pub route_kind: String,
    pub reply_identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeskSnapshot {
    pub operator: String,
    pub preview: bool,
    pub threads: Vec<ThreadSummary>,
    pub open_count: usize,
    pub outbound_mode: String,
    pub operator_delivery_mode: String,
    pub routes: Vec<RouteHealthSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RouteHealthSummary {
    pub route_address: String,
    pub decision_kind: String,
    pub desired_provider: String,
    pub observed_provider: Option<String>,
    pub operator_count: usize,
    pub reply_identity: String,
    pub inbound_status: String,
    pub reply_status: String,
    pub last_inbound_at: Option<String>,
    pub last_reply_at: Option<String>,
    pub last_error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageSummary {
    pub id: String,
    pub direction: String,
    pub envelope_from: String,
    pub envelope_to: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditSummary {
    pub id: String,
    pub actor: String,
    pub action: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadDetail {
    pub thread: ThreadSummary,
    pub messages: Vec<MessageSummary>,
    pub audit: Vec<AuditSummary>,
    pub allowed_reply_identities: Vec<String>,
    pub outbound_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReplyReceipt {
    pub queued: bool,
    pub message_id: String,
    pub from_identity: String,
}

#[server(prefix = "/desk/api")]
pub async fn load_desk() -> Result<DeskSnapshot, ServerFnError> {
    #[cfg(feature = "ssr")]
    {
        send_wrapper::SendWrapper::new(async move {
            crate::server::desk::load_desk()
                .await
                .map_err(crate::server::server_error)
        })
        .await
    }

    #[cfg(not(feature = "ssr"))]
    {
        unreachable!("server functions only execute on the server")
    }
}

#[server(prefix = "/desk/api")]
pub async fn load_thread(thread_id: String) -> Result<ThreadDetail, ServerFnError> {
    #[cfg(feature = "ssr")]
    {
        send_wrapper::SendWrapper::new(async move {
            crate::server::desk::load_thread(thread_id)
                .await
                .map_err(crate::server::server_error)
        })
        .await
    }

    #[cfg(not(feature = "ssr"))]
    {
        unreachable!("server functions only execute on the server")
    }
}

#[server(prefix = "/desk/api")]
pub async fn queue_reply(
    thread_id: String,
    from_identity: String,
    subject: String,
    body: String,
) -> Result<ReplyReceipt, ServerFnError> {
    #[cfg(feature = "ssr")]
    {
        send_wrapper::SendWrapper::new(async move {
            crate::server::desk::queue_reply(thread_id, from_identity, subject, body)
                .await
                .map_err(crate::server::server_error)
        })
        .await
    }

    #[cfg(not(feature = "ssr"))]
    {
        unreachable!("server functions only execute on the server")
    }
}
