import { Redis } from "@upstash/redis";
import type { Proposal, Outcome } from "./schema";

const redis = Redis.fromEnv(); // reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN

const ns = (key: string) => `mailroom:${key}`;

/** Cached AI decision for a dossier, keyed by canonical content fingerprint (not evaluationId/auditId). */
export async function getCachedDecision(fingerprint: string): Promise<Proposal | null> {
  return (await redis.get<Proposal>(ns(`decision:${fingerprint}`))) ?? null;
}

export async function saveCachedDecision(fingerprint: string, proposal: Proposal): Promise<void> {
  await redis.set(ns(`decision:${fingerprint}`), proposal);
}

interface ProposalRecord {
  dossierFingerprint: string;
  proposal: Proposal;
  proposalDigest: string;
}

/**
 * Stores the exact proposal + its digest for (evaluationId, dossierId), so that:
 *  - exact propose replays return the same response without recomputation
 *  - changed content under the same evaluationId can be detected -> 409
 *  - commit can look up the authoritative proposal by dossierId+callId
 */
export async function getStoredProposalRecord(
  evaluationId: string,
  dossierId: string
): Promise<ProposalRecord | null> {
  return (
    (await redis.get<ProposalRecord>(ns(`proposal:${evaluationId}:${dossierId}`))) ?? null
  );
}

export async function saveProposalRecord(
  evaluationId: string,
  dossierId: string,
  record: ProposalRecord
): Promise<void> {
  await redis.set(ns(`proposal:${evaluationId}:${dossierId}`), record);
  // Secondary index by callId, since commit receipts key off callId primarily.
  await redis.set(ns(`callid:${evaluationId}:${record.proposal.callId}`), dossierId);
}

export async function getDossierIdForCallId(
  evaluationId: string,
  callId: string
): Promise<string | null> {
  return (await redis.get<string>(ns(`callid:${evaluationId}:${callId}`))) ?? null;
}

/** The inputDigest computed at propose-time for an evaluation, so commit can confirm it matches. */
export async function saveEvaluationInputDigest(
  evaluationId: string,
  inputDigest: string
): Promise<void> {
  await redis.set(ns(`inputdigest:${evaluationId}`), inputDigest);
}

export async function getEvaluationInputDigest(evaluationId: string): Promise<string | null> {
  return (await redis.get<string>(ns(`inputdigest:${evaluationId}`))) ?? null;
}

/** Ed25519 public key JWK supplied in the propose request's receiptVerifier, needed to verify commit-time receipts. */
export async function saveEvaluationVerifierKey(
  evaluationId: string,
  publicKeyJwk: unknown
): Promise<void> {
  await redis.set(ns(`verifierkey:${evaluationId}`), publicKeyJwk);
}

export async function getEvaluationVerifierKey(evaluationId: string): Promise<any | null> {
  return (await redis.get<any>(ns(`verifierkey:${evaluationId}`))) ?? null;
}

/** Outcome of a committed receipt, keyed by receiptId for exact-replay safety (nonce is unguessable and unique per receipt). */
export async function getStoredOutcome(receiptId: string): Promise<Outcome | null> {
  return (await redis.get<Outcome>(ns(`outcome:${receiptId}`))) ?? null;
}

export async function saveOutcome(receiptId: string, outcome: Outcome): Promise<void> {
  await redis.set(ns(`outcome:${receiptId}`), outcome);
}

/** Tracks which callIds have already produced a real downstream effect, to prevent double-execution across replays. */
export async function markEffectExecuted(callId: string): Promise<boolean> {
  const result = await redis.set(ns(`effect:${callId}`), true, { nx: true });
  return result === "OK";
}
