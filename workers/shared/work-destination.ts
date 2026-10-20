import type { DispositionCandidate, RouteDecision } from "./router";

/** A destination consumer must durably deduplicate deliveryId before accepting.
 * A timeout/exception is an unknown outcome and never selects a fallback.
 * No production work destination adapter ships in this baseline.
 */
export interface DurableWorkDestination {
  contract: "durable-work-handoff-v1";
  queueRef: string;
  handoff(input: { deliveryId: string; routeRef: string; rawR2Key: string }): Promise<{
    deliveryId: string;
    receiptId: string;
    outcome: "durably_accepted";
  }>;
}

export type SelectedDestination = DispositionCandidate & {
  routeRef: string;
  fallbackUsed: boolean;
  adapter?: DurableWorkDestination;
};

/** Selection is pure and completes before mail, storage or Queue effects. */
export function selectDestination(
  route: RouteDecision,
  adapters: ReadonlyMap<string, DurableWorkDestination> = new Map(),
): SelectedDestination | null {
  if (!route.disposition) {
    return route.operators.length || route.routeKind === "sink" ? {
      routeRef: `route:${route.domain}:${route.localPart}`,
      destinationRef: `legacy:${route.domain}:${route.localPart}`,
      accountableRef: "legacy:operators", fallbackUsed: false,
      target: { kind: "mailbox", recipients: route.operators },
    } : null;
  }
  for (const [index, candidate] of route.disposition.candidates.entries()) {
    if (candidate.target.kind === "mailbox" && candidate.target.recipients.length > 0) {
      return { ...candidate, routeRef: route.disposition.routeRef, fallbackUsed: index > 0 };
    }
    if (candidate.target.kind === "work_queue") {
      const adapter = adapters.get(candidate.target.queueRef);
      if (adapter?.contract === "durable-work-handoff-v1" &&
          adapter.queueRef === candidate.target.queueRef && typeof adapter.handoff === "function") {
        return { ...candidate, routeRef: route.disposition.routeRef, fallbackUsed: index > 0, adapter };
      }
    }
  }
  return null;
}

export async function handoffSelectedWork(
  selected: SelectedDestination,
  input: { deliveryId: string; rawR2Key: string },
): Promise<"durably_accepted" | "recovery_required"> {
  if (selected.target.kind !== "work_queue" || !selected.adapter ||
      selected.adapter.queueRef !== selected.target.queueRef) {
    throw new Error("work destination adapter unavailable");
  }
  try {
    const result = await selected.adapter.handoff({ ...input, routeRef: selected.routeRef });
    return result.outcome === "durably_accepted" && result.deliveryId === input.deliveryId && result.receiptId
      ? "durably_accepted" : "recovery_required";
  } catch {
    return "recovery_required";
  }
}
