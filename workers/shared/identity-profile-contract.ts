import type { ResolvedIdentityProfile } from "./router";

/** Frozen v1 runtime profile digest preimage. Property order is part of v1. */
export function identityProfileDigestInputV1(profile: ResolvedIdentityProfile, signatureSha256: string) {
  return {
    schema_version: 1,
    profile_ref: profile.profileRef,
    public_address: profile.publicAddress.trim().toLowerCase(),
    display_name: profile.displayName,
    signature_profile_ref: profile.signatureProfileRef,
    signature_sha256: signatureSha256,
    sender_adapter: profile.senderAdapter,
  };
}
