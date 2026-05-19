// Cloudflare Email Worker adapter placeholder.
//
// Routing policy belongs in crates/maildesk-router. This Worker should stay a
// thin adapter from Cloudflare email events into the Rust router once the WASM
// bridge is wired.

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleInbound(message, env));
  },
};

async function handleInbound(message: ForwardableEmailMessage, env: Env): Promise<void> {
  await env.MAIL_JOBS.send({
    kind: "inbound_email_received",
    envelopeTo: message.to,
    envelopeFrom: message.from,
    receivedAt: new Date().toISOString(),
  });
}

interface Env {
  MAIL_JOBS: Queue;
}
