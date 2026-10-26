export class RequestDeadlineError extends Error {
  constructor() { super("request deadline exceeded"); }
}

/** Bounds read/monitor work even if a transport fails to honor cancellation.
 * Sending mail must retain its separate durable claim and reconciliation path.
 */
export async function withRequestDeadline<T>(
  milliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new RequestDeadlineError();
      controller.abort(error);
      reject(error);
    }, milliseconds);
  });
  try { return await Promise.race([operation(controller.signal), deadline]); }
  finally { clearTimeout(timer!); }
}
