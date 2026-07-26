import { createPublicKey, verify as edVerify } from "crypto";
import { canonicalStringify } from "./hash";

interface PublicKeyJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

/**
 * Signed message = recursively key-sorted, compact JSON of:
 *   { profile, evaluationId, inputDigest, receipt: {...every receipt field except receiptSignature} }
 * where `receipt` is the exact per-receipt entry as sent (dossierId, callId,
 * action, accepted, proposalDigest, receiptId) -- no reordering, no dropped
 * fields, no added fields beyond what the grader sent minus the signature
 * itself.
 *
 * Still worth a quick empirical check on your first real round-trip: if
 * verification fails, temporarily log the raw receipt + this constructed
 * message (dev/sandbox runs only, never against real graded evaluations)
 * and compare byte-for-byte against what you'd expect.
 */
export function receiptSignedMessage(params: {
  profile: string;
  evaluationId: string;
  inputDigest: string;
  receipt: {
    dossierId: string;
    callId: string;
    action: string;
    accepted: boolean;
    proposalDigest: string;
    receiptId: string;
  };
}): Buffer {
  const scoped = {
    profile: params.profile,
    evaluationId: params.evaluationId,
    inputDigest: params.inputDigest,
    receipt: {
      dossierId: params.receipt.dossierId,
      callId: params.receipt.callId,
      action: params.receipt.action,
      accepted: params.receipt.accepted,
      proposalDigest: params.receipt.proposalDigest,
      receiptId: params.receipt.receiptId,
    },
  };
  return Buffer.from(canonicalStringify(scoped), "utf8");
}

export function verifyReceiptSignature(
  publicKeyJwk: PublicKeyJwk,
  message: Buffer,
  signatureBase64: string
): boolean {
  try {
    const keyObject = createPublicKey({
      key: { ...publicKeyJwk, key_ops: ["verify"] } as any,
      format: "jwk",
    });
    const signature = Buffer.from(signatureBase64, "base64");
    // Ed25519 uses null for the digest algorithm parameter in Node's verify.
    return edVerify(null, message, keyObject, signature);
  } catch {
    return false;
  }
}
