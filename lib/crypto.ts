import { createPublicKey, verify as edVerify } from "crypto";
import { canonicalStringify } from "./hash";

interface PublicKeyJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

/**
 * IMPORTANT / UNCONFIRMED: the spec doesn't state the exact byte sequence
 * the grader signs to produce `receiptSignature`. Based on "A receipt is
 * scoped to its evaluation, proposal digest, and call ID," this verifies
 * against the canonical (key-sorted, compact) JSON of the fields the spec
 * explicitly calls scoping-relevant: evaluationId, dossierId, callId,
 * action, accepted, proposalDigest, receiptId.
 *
 * If your first real propose/commit round-trip fails verification, that's
 * the first thing to check -- capture one real (evaluationId, receipt)
 * pair and try alternate canonical constructions (e.g. only
 * evaluationId+proposalDigest+callId+receiptId+accepted, or including
 * `profile`/`inputDigest`) until verification succeeds. Log the raw
 * receipt + attempted message during dev, then remove the log before
 * submitting.
 */
export function receiptSignedMessage(receipt: {
  evaluationId: string;
  dossierId: string;
  callId: string;
  action: string;
  accepted: boolean;
  proposalDigest: string;
  receiptId: string;
}): Buffer {
  const scoped = {
    evaluationId: receipt.evaluationId,
    dossierId: receipt.dossierId,
    callId: receipt.callId,
    action: receipt.action,
    accepted: receipt.accepted,
    proposalDigest: receipt.proposalDigest,
    receiptId: receipt.receiptId,
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
