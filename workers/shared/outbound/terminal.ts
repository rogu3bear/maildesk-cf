import type { MaildeskEnv as Env,InboxReplyReceivedJob,OutboundReplyRequestedJob } from "../contracts";
import { admissionTable,replyAuthorizationKind } from "../ordinary-reply";
import { loadStoredReplyClaim,type StoredReplyClaim } from "../reply-recovery";
import { auditOperator,auditSendResult,recordAuditEvent,terminalSendRecordForDedupeKey } from "./audit";
import { configuredOutboundMode } from "./configuration";
import { terminalProviderErrorCode } from "./provider-errors";
import type { OutboundSendResult,TerminalSendAction } from "./types";

export async function recordTerminalSendEvent(
  job: OutboundReplyRequestedJob,
  env: Env,
  action: "outbound_reply_delivered" | "outbound_reply_failed" | "outbound_reply_recovery_required",
  result: OutboundSendResult,
): Promise<void> {
  const recorded = await recordAuditEvent(
    env,
    await auditOperator(env, job.operator),
    action,
    {
      messageId: job.messageId,
      threadId: job.threadId,
      fromIdentity: job.fromIdentity,
      to: job.to,
      // Keep the legacy event key readable by old evidence consumers. Its
      // explicit outcome is provider acceptance, never an external receipt.
      outcome: action === "outbound_reply_delivered" ? "provider_accepted"
        : action === "outbound_reply_failed" ? "failed" : "recovery_required",
      result: auditSendResult(result),
    },
    `${job.messageId}:outbound_reply_result`,
    job.threadId,
  );
  const durable = recorded ? { action, result }
    : await terminalSendRecordForDedupeKey(env, `${job.messageId}:outbound_reply_result`);
  if (!durable) throw new Error("terminal send result is unavailable");
  await finalizeTerminalSendState(job, env, durable.action, durable.result);
}

export async function finalizeTerminalSendState(
  job: OutboundReplyRequestedJob,
  env: Env,
  action: TerminalSendAction,
  result: OutboundSendResult,
): Promise<void> {
  if (job.relayAttemptId) {
    if (!job.policySha256) throw new Error("relay terminal result is missing policy authority");
    const status = action === "outbound_reply_delivered"
      ? "provider_accepted"
      : action === "outbound_reply_recovery_required"
        ? "recovery_required"
        : "failed";
    await env.DB.prepare(
      "UPDATE relay_attempts SET status = ?1, provider_message_id = ?2, error_code = ?3, updated_at = CURRENT_TIMESTAMP WHERE id = ?4",
    )
      .bind(
        status,
        result.providerMessageId ?? null,
        terminalProviderErrorCode(result, status),
        job.relayAttemptId,
      )
      .run();
    if (job.admissionId && job.transactionSha256) {
      await env.DB.prepare(
        `UPDATE ${admissionTable(replyAuthorizationKind(job) ?? "canary")} SET status = ?1, terminal_at = COALESCE(terminal_at, CURRENT_TIMESTAMP), error_code = ?2 WHERE id = ?3 AND transaction_sha256 = ?4 AND claimed_attempt_id = ?5 AND status IN ('claimed', 'sending', ?1)`,
      )
        .bind(
          status,
          terminalProviderErrorCode(result, status),
          job.admissionId,
          job.transactionSha256,
          job.relayAttemptId,
        )
        .run();
    }
    const projected = await env.DB.prepare(
      "UPDATE route_health SET reply_status = CASE WHEN ?1 = 'provider_accepted' AND reply_status = 'reply_verified' THEN reply_status ELSE ?1 END, last_reply_at = CASE WHEN ?1 = 'provider_accepted' THEN CURRENT_TIMESTAMP ELSE last_reply_at END, last_reply_provider_accepted_at = CASE WHEN ?1 = 'provider_accepted' THEN CURRENT_TIMESTAMP ELSE last_reply_provider_accepted_at END, last_reply_provider_message_id = CASE WHEN ?1 = 'provider_accepted' THEN ?2 ELSE last_reply_provider_message_id END, last_error_code = ?3, updated_at = CURRENT_TIMESTAMP WHERE route_id = (SELECT rr.route_id FROM relay_attempts ra JOIN reply_relays rr ON rr.id = ra.relay_id WHERE ra.id = ?4) AND policy_sha256 = ?5 AND EXISTS (SELECT 1 FROM runtime_state rs WHERE rs.singleton = 1 AND rs.active_policy_sha256 = ?5)",
    )
      .bind(
        status,
        result.providerMessageId ?? null,
        terminalProviderErrorCode(result, status),
        job.relayAttemptId,
        job.policySha256,
      )
      .run();
    if (Number(projected.meta?.changes ?? 0) === 0) {
      const runtime = await env.DB.prepare(
        "SELECT active_policy_sha256 FROM runtime_state WHERE singleton = 1",
      ).first<{ active_policy_sha256: string }>();
      if (!runtime?.active_policy_sha256 || runtime.active_policy_sha256 === job.policySha256) {
        throw new Error("active route health revision is unavailable for terminal reply projection");
      }
      await recordAuditEvent(
        env,
        "system",
        "outbound_reply_result_superseded",
        {
          messageId: job.messageId,
          threadId: job.threadId,
          relayAttemptId: job.relayAttemptId,
          policySha256: job.policySha256,
          result: auditSendResult(result),
        },
        `${job.messageId}:outbound_reply_result_superseded`,
        job.threadId,
      );
      if (action === "outbound_reply_delivered" && job.relaySpoolKey) {
        if (!env.RELAY_SPOOL) throw new Error("relay spool binding unavailable");
        await env.RELAY_SPOOL.delete(job.relaySpoolKey);
        await env.DB.prepare(
          "UPDATE relay_attempts SET raw_r2_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        ).bind(job.relayAttemptId).run();
      }
      return;
    }
    if (action === "outbound_reply_delivered" && job.relaySpoolKey) {
      if (!env.RELAY_SPOOL) throw new Error("relay spool binding unavailable");
      await env.RELAY_SPOOL.delete(job.relaySpoolKey);
      await env.DB.prepare(
        "UPDATE relay_attempts SET raw_r2_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
      )
        .bind(job.relayAttemptId)
        .run();
    }
  }
}

export function inboxJobMatchesClaim(job: InboxReplyReceivedJob, claim: StoredReplyClaim): boolean {
  return (job.payloadVersion ?? 1) === claim.payload_version && replyAuthorizationKind(job) === claim.admission_kind && (job.activationId ?? null) === claim.activation_id &&
    job.attemptId === claim.id && job.relayId === claim.relay_id &&
    job.admissionId === claim.admission_id && job.transactionSha256 === claim.transaction_sha256 &&
    job.attemptSha256 === claim.attempt_sha256 && job.claimedPayloadSha256 === claim.claimed_payload_sha256 &&
    job.desiredStateSha256 === claim.desired_state_sha256 && job.identityProfileSha256 === claim.identity_profile_sha256 &&
    job.operator === claim.operator && job.operatorMessageId === claim.operator_message_id && job.rawSha256 === claim.raw_sha256;
}

export async function resumeInboxTerminal(job: InboxReplyReceivedJob, env: Env): Promise<boolean> {
  const terminal = await terminalSendRecordForDedupeKey(env, `${job.attemptId.replace(/^relay-attempt:/, "")}:outbound_reply_result`);
  const claim = await loadStoredReplyClaim(job.attemptId, env);
  // The regular immutable spool check still admits pending old Queue contracts.
  if (!claim?.id) {
    if (terminal) throw new Error("terminal result has no immutable reply claim");
    return false;
  }
  if (!inboxJobMatchesClaim(job, claim)) return true;
  if (terminal) {
    await finalizeTerminalSendState({
      kind: "outbound_reply_requested", schemaVersion: 2, admissionKind: claim.admission_kind,
      ...(claim.activation_id ? { activationId: claim.activation_id } : {}), messageId: claim.id.replace(/^relay-attempt:/, ""),
      threadId: claim.thread_id, operator: claim.operator, envelopeTo: claim.route_address,
      fromIdentity: claim.public_identity, to: [], subject: "", queuedAt: claim.dispatch_received_at,
      relayAttemptId: claim.id, relaySpoolKey: claim.raw_r2_key ?? undefined,
      admissionId: claim.admission_id, transactionSha256: claim.transaction_sha256, policySha256: claim.policy_sha256,
    }, env, terminal.action, terminal.result);
    return true;
  }
  if (["provider_accepted", "failed", "recovery_required"].includes(claim.status)) return true;
  // Another consumer may still own this call. Preserve its state and never
  // manufacture a definitive failure from the absence of its acknowledgement.
  return claim.admission_status === "sending" && configuredOutboundMode(env) !== "resend";
}
