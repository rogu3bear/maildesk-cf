export const MCP_MAX_REQUEST_BYTES = 65_536;
export class McpRequestError extends Error {
  constructor(readonly status: number, code: string) { super(code); }
}

/** The SDK bounds size but does not cancel a stalled body reader on abort. */
export async function boundedMcpRequest(request: Request, signal: AbortSignal): Promise<Request> {
  if (Number(request.headers.get("content-length")) > MCP_MAX_REQUEST_BYTES) {
    void request.body?.cancel().catch(() => undefined);
    throw new McpRequestError(413, "mcp_request_too_large");
  }
  const reader = request.body?.getReader();
  if (!reader) return new Request(request, { signal });
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MCP_MAX_REQUEST_BYTES) throw new McpRequestError(413, "mcp_request_too_large");
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock();
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new Request(request, { body: bytes.buffer, signal });
}
