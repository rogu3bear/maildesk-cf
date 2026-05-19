// HTTP API placeholder for the mail desk.
//
// The final API should expose authenticated thread reads, reply composition,
// identity policy, and audit views. Cloudflare account setup belongs in cfctl,
// not in this Worker.

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "maildesk-cf" });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
};
