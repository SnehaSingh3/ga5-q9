import { createHash } from "crypto";

/**
 * Canonical JSON stringify: sorts object keys recursively so that
 * semantically-identical objects always hash identically regardless
 * of key order in the incoming request.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Fingerprint of a single dossier's content (used for caching + conflict detection). */
export function dossierFingerprint(dossier: unknown): string {
  return sha256Hex(canonicalStringify(dossier));
}

/**
 * inputDigest per spec: SHA-256 over UTF-8 bytes of the `dossiers` array,
 * encoded as recursively key-sorted, compact JSON. Arrays keep their order
 * (only object keys are sorted, never array element order).
 */
export function computeInputDigest(dossiers: unknown[]): string {
  return sha256Hex(canonicalStringify(dossiers));
}

/**
 * Semantic content digest for conflict detection: covers the WHOLE
 * meaningful propose envelope (profile, dossiers, corpus, allowedActions,
 * receiptVerifier) -- not just the dossiers. This is deliberately separate
 * from `inputDigest`, which per spec must stay scoped to `dossiers` only
 * (it's echoed back and matched against on commit). A single-character
 * change anywhere in this broader envelope -- e.g. the receiptVerifier's
 * public key, or the profile string -- under an already-seen evaluationId
 * is content drift and must be rejected with 409, even though the dossiers
 * themselves (and therefore inputDigest) are byte-identical.
 */
export function computeSemanticDigest(envelope: {
  profile: string;
  dossiers: unknown[];
  corpus: unknown;
  allowedActions: unknown[];
  receiptVerifier: unknown;
}): string {
  return sha256Hex(canonicalStringify(envelope));
}

/**
 * proposalDigest per spec: keep exactly dossierId, callId, action, target
 * (null when absent), payload, evidence (sorted); hash the recursively
 * key-sorted compact JSON view. Extra fields (e.g. our internal ones) must
 * NOT be included.
 */
export function computeProposalDigest(proposal: {
  dossierId: string;
  callId: string;
  action: string;
  target: unknown;
  payload: unknown;
  evidence: string[];
}): string {
  const normalized = {
    dossierId: proposal.dossierId,
    callId: proposal.callId,
    action: proposal.action,
    target: proposal.target ?? null,
    payload: proposal.payload,
    evidence: [...proposal.evidence].sort(),
  };
  return sha256Hex(canonicalStringify(normalized));
}
