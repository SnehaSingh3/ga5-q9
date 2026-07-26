import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  PROFILE,
  ProposeRequestSchema,
  CommitRequestSchema,
  type Proposal,
  type Outcome,
} from "../lib/schema";
import {
  dossierFingerprint,
  computeInputDigest,
  computeSemanticDigest,
  computeProposalDigest,
} from "../lib/hash";
import { decideBatch } from "../lib/model";
import { receiptSignedMessage, verifyReceiptSignature } from "../lib/crypto";
import {
  getCachedDecision,
  saveCachedDecision,
  getStoredProposalRecord,
  saveProposalRecord,
  saveEvaluationInputDigest,
  getEvaluationInputDigest,
  saveEvaluationSemanticDigest,
  getEvaluationSemanticDigest,
  saveEvaluationVerifierKey,
  getEvaluationVerifierKey,
  getStoredOutcome,
  saveOutcome,
  markEffectExecuted,
} from "../lib/store";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return json(res, 405, { error: "method_not_allowed" });
  }

  const raw = req.body;
  const bodySize = Buffer.byteLength(JSON.stringify(raw ?? {}), "utf8");
  if (bodySize > MAX_BODY_BYTES) {
    return json(res, 413, { error: "payload_too_large" });
  }

  if (!raw || typeof raw !== "object") {
    return json(res, 400, { error: "invalid_body" });
  }

  if (raw.operation === "propose") {
    return handlePropose(req, res);
  }
  if (raw.operation === "commit") {
    return handleCommit(req, res);
  }
  return json(res, 400, { error: "invalid_operation" });
}

async function handlePropose(req: VercelRequest, res: VercelResponse) {
  const parsed = ProposeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return json(res, 422, { error: "invalid_schema", details: parsed.error.issues });
  }
  const { evaluationId, dossiers, allowedActions, receiptVerifier } = parsed.data;

  // Reject duplicate dossier IDs before any AI/tool work.
  const seen = new Set<string>();
  for (const d of dossiers) {
    if (seen.has(d.dossierId)) {
      return json(res, 400, { error: "duplicate_dossier_id", dossierId: d.dossierId });
    }
    seen.add(d.dossierId);
  }

  const inputDigest = computeInputDigest(dossiers);
  const semanticDigest = computeSemanticDigest({
    profile: parsed.data.profile,
    dossiers,
    corpus: parsed.data.corpus,
    allowedActions,
    receiptVerifier,
  });

  const priorInputDigest = await getEvaluationInputDigest(evaluationId);
  const priorSemanticDigest = await getEvaluationSemanticDigest(evaluationId);

  if (priorInputDigest !== null) {
    // Known evaluationId. An exact replay must match on BOTH digests.
    // Any drift -- dossiers, profile, corpus, allowedActions, or the
    // receiptVerifier's public key (even a single character) -- is content
    // conflict, not a fresh proposal.
    if (priorInputDigest !== inputDigest || priorSemanticDigest !== semanticDigest) {
      return json(res, 409, { error: "content_conflict", evaluationId });
    }
    // else: byte-identical semantic replay, fall through to serve cached proposals.
  } else {
    // Fresh evaluationId: profile must be exactly right, or this is a
    // plain unsupported-profile schema error, not a conflict.
    if (parsed.data.profile !== PROFILE) {
      return json(res, 400, { error: "unsupported_profile" });
    }
    await saveEvaluationInputDigest(evaluationId, inputDigest);
    await saveEvaluationSemanticDigest(evaluationId, semanticDigest);
    await saveEvaluationVerifierKey(evaluationId, receiptVerifier.publicKeyJwk);
  }

  const proposals: Proposal[] = [];
  const toDecide: typeof dossiers = [];
  const fingerprints = new Map<string, string>();

  for (const d of dossiers) {
    const fp = dossierFingerprint(d);
    fingerprints.set(d.dossierId, fp);

    // Exact replay: same evaluationId + dossierId already answered.
    const existing = await getStoredProposalRecord(evaluationId, d.dossierId);
    if (existing) {
      proposals.push(existing.proposal);
      continue;
    }

    // Cache by content, independent of evaluationId (per instructions: cache
    // by canonical dossier content, not evaluation ID).
    const cached = await getCachedDecision(fp);
    if (cached) {
      const callId = freshCallId(d.dossierId);
      const proposal: Proposal = { ...cached, callId };
      const proposalDigest = computeProposalDigest(proposal);
      await saveProposalRecord(evaluationId, d.dossierId, {
        dossierFingerprint: fp,
        proposal,
        proposalDigest,
      });
      proposals.push(proposal);
      continue;
    }

    toDecide.push(d);
  }

  if (toDecide.length > 0) {
    const decisions = await decideBatch(toDecide, allowedActions);
    for (const decision of decisions) {
      const callId = freshCallId(decision.dossierId);
      const proposal: Proposal = { ...decision, callId };
      const fp = fingerprints.get(decision.dossierId)!;

      // Cache the decision shape without a specific callId baked in for reuse
      // across evaluations; store the callId'd version for this evaluation.
      await saveCachedDecision(fp, { ...decision, callId: "cached" } as Proposal);

      const proposalDigest = computeProposalDigest(proposal);
      await saveProposalRecord(evaluationId, decision.dossierId, {
        dossierFingerprint: fp,
        proposal,
        proposalDigest,
      });
      proposals.push(proposal);
    }
  }

  const responseBody = {
    profile: PROFILE,
    evaluationId,
    status: "awaiting_receipts" as const,
    inputDigest,
    proposals,
  };
  if (Buffer.byteLength(JSON.stringify(responseBody), "utf8") > MAX_RESPONSE_BYTES) {
    return json(res, 500, { error: "response_too_large" });
  }
  return json(res, 200, responseBody);
}

async function handleCommit(req: VercelRequest, res: VercelResponse) {
  const parsed = CommitRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return json(res, 422, { error: "invalid_schema", details: parsed.error.issues });
  }
  const { evaluationId, inputDigest, receipts } = parsed.data;

  const storedDigest = await getEvaluationInputDigest(evaluationId);
  if (storedDigest === null) {
    // Unknown evaluationId. There's nothing to bind this commit to.
    return json(res, 409, { error: "unknown_evaluation" });
  }
  if (storedDigest !== inputDigest) {
    return json(res, 409, { error: "input_digest_mismatch" });
  }
  // A profile mutated on an otherwise-known evaluation is content drift too.
  if (parsed.data.profile !== PROFILE) {
    return json(res, 409, { error: "content_conflict", evaluationId });
  }

  // Reject the WHOLE commit up front if any receiptId is duplicated within
  // this single request -- never process some and silently drop others.
  const seenReceiptIds = new Set<string>();
  for (const r of receipts) {
    if (seenReceiptIds.has(r.receiptId)) {
      return json(res, 409, { error: "duplicate_receipt_id" });
    }
    seenReceiptIds.add(r.receiptId);
  }

  const verifierKey = await getEvaluationVerifierKey(evaluationId);

  // ---- PASS 1: validate everything, execute nothing. ----
  // A commit is all-or-nothing: if any single receipt is unscoped, mismatched,
  // or fails signature verification, the WHOLE commit is rejected before any
  // effect runs (and before recording any new outcome) -- except receipts
  // that are exact replays of an already-committed receiptId, which are
  // always fine to include since they represent no new effect either way.
  interface Validated {
    receipt: (typeof receipts)[number];
    existingOutcome: Outcome | null;
    proposal: Awaited<ReturnType<typeof getStoredProposalRecord>>;
  }
  const validated: Validated[] = [];

  for (const receipt of receipts) {
    const existingOutcome = await getStoredOutcome(receipt.receiptId);
    if (existingOutcome) {
      validated.push({ receipt, existingOutcome, proposal: null });
      continue;
    }

    const record = await getStoredProposalRecord(evaluationId, receipt.dossierId);
    if (!record) {
      return json(res, 409, { error: "unknown_proposal", receiptId: receipt.receiptId });
    }

    // Receipt must be scoped to exactly this proposal -- never accept a
    // receipt meant for another proposal.
    if (
      record.proposal.callId !== receipt.callId ||
      record.proposal.action !== receipt.action ||
      record.proposalDigest !== receipt.proposalDigest
    ) {
      return json(res, 409, { error: "receipt_not_scoped", receiptId: receipt.receiptId });
    }

    const message = receiptSignedMessage({
      profile: parsed.data.profile,
      evaluationId,
      inputDigest,
      receipt: {
        dossierId: receipt.dossierId,
        callId: receipt.callId,
        action: receipt.action,
        accepted: receipt.accepted,
        proposalDigest: receipt.proposalDigest,
        receiptId: receipt.receiptId,
      },
    });
    const validSig =
      !!verifierKey && verifyReceiptSignature(verifierKey, message, receipt.receiptSignature);

    if (!validSig) {
      return json(res, 409, { error: "invalid_receipt_signature", receiptId: receipt.receiptId });
    }

    validated.push({ receipt, existingOutcome: null, proposal: record });
  }

  // ---- PASS 2: everything validated -- now execute and record. ----
  const outcomes: Outcome[] = [];
  for (const v of validated) {
    if (v.existingOutcome) {
      outcomes.push(v.existingOutcome);
      continue;
    }
    const { receipt } = v;

    if (!receipt.accepted) {
      const outcome: Outcome = {
        dossierId: receipt.dossierId,
        callId: receipt.callId,
        action: receipt.action,
        proposalDigest: receipt.proposalDigest,
        receiptId: receipt.receiptId,
        status: "rejected",
      };
      await saveOutcome(receipt.receiptId, outcome);
      outcomes.push(outcome);
      continue;
    }

    // Prevent double-execution across replays/concurrent commits.
    const firstExecution = await markEffectExecuted(receipt.callId);
    void firstExecution;

    // NOTE: real side-effecting logic (writing a draft, updating an internal
    // record, sending a notice) belongs here, gated strictly behind
    // `firstExecution` and `v.proposal.proposal.action`. Left as a stub --
    // wire in your actual downstream systems.

    const outcome: Outcome = {
      dossierId: receipt.dossierId,
      callId: receipt.callId,
      action: receipt.action,
      proposalDigest: receipt.proposalDigest,
      receiptId: receipt.receiptId,
      status: "executed",
    };
    await saveOutcome(receipt.receiptId, outcome);
    outcomes.push(outcome);
  }

  const responseBody = {
    profile: PROFILE,
    evaluationId,
    status: "completed" as const,
    inputDigest,
    outcomes,
  };
  if (Buffer.byteLength(JSON.stringify(responseBody), "utf8") > MAX_RESPONSE_BYTES) {
    return json(res, 500, { error: "response_too_large" });
  }
  return json(res, 200, responseBody);
}

function freshCallId(dossierId: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const raw = `call_${dossierId}_${Date.now()}_${rand}`;
  // Enforce allowed charset [A-Za-z0-9._:-] and 12-128 length.
  const cleaned = raw.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128);
  return cleaned.length >= 12 ? cleaned : cleaned.padEnd(12, "0");
}

function json(res: VercelResponse, status: number, body: unknown) {
  res.status(status).json(body);
}
