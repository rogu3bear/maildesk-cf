import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileDispatchRecovery, compileRouteActivation, compileRouteContainment } from "./route-reply-control-contract";

export function compileRouteReplyOperation(mode: string, input: unknown) {
  if (mode === "activation") return compileRouteActivation(input);
  if (mode === "recovery") return compileDispatchRecovery(input);
  if (mode === "containment") return compileRouteContainment(input);
  throw new Error("expected activation, recovery or containment");
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.length !== 5 || args[1] !== "--input" || args[3] !== "--out") {
    throw new Error("usage: activation|recovery|containment --input INPUT --out NEW_FILE; this command cannot execute a provider effect");
  }
  const source = readFileSync(resolve(args[2]!), "utf8");
  if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw new Error("operation input exceeds size limit");
  const proposal = compileRouteReplyOperation(args[0]!, JSON.parse(source));
  writeFileSync(resolve(args[4]!), `${JSON.stringify(proposal, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ performed: false, execution_supported: false, integration_status: proposal.integration_status, proposal_sha256: proposal.proposal_sha256 }));
}
