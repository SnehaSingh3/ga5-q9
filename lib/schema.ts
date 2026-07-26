import { z } from "zod";

export const PROFILE = "ga5-mailroom-action-gate/v2";

export const ActionType = z.enum([
  "create_draft",
  "update_internal_record",
  "send_approved_notice",
  "request_confirmation",
  "quarantine_item",
  "no_action",
]);

const LineSchema = z.object({
  lineId: z.string().min(1),
  text: z.string(),
});

const SourceSchema = z.object({
  sourceId: z.string().min(1),
  kind: z.string(),
  provenance: z.string(),
  title: z.string().optional(),
  lines: z.array(LineSchema),
});

export const DossierSchema = z.object({
  dossierId: z.string().min(1),
  partition: z.enum(["stable_core", "fresh_audit"]),
  receivedAt: z.string(),
  mailbox: z.string(),
  objective: z.string(),
  sources: z.array(SourceSchema),
});

const PublicKeyJwkSchema = z.object({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string(),
});

const ReceiptVerifierSchema = z.object({
  algorithm: z.literal("Ed25519"),
  publicKeyJwk: PublicKeyJwkSchema,
});

const CorpusSchema = z.object({
  coreId: z.string(),
  auditId: z.string(),
  stableCount: z.number(),
  freshCount: z.number(),
});

export const ProposeRequestSchema = z.object({
  // Not a literal: a wrong profile on a KNOWN evaluationId is content drift
  // (-> 409), while a wrong profile on a fresh evaluationId is a plain
  // schema/support error (-> 400). The handler enforces this distinction.
  profile: z.string(),
  operation: z.literal("propose"),
  evaluationId: z.string().min(1),
  receiptVerifier: ReceiptVerifierSchema,
  corpus: CorpusSchema,
  allowedActions: z.array(ActionType),
  dossiers: z.array(DossierSchema).min(1),
});

// callId: 12-128 chars from A-Z a-z 0-9 . _ : -
const CallIdSchema = z
  .string()
  .min(12)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const TargetSchema = z
  .object({
    kind: z.string(),
    id: z.string(),
  })
  .nullable();

export const ProposalSchema = z.object({
  dossierId: z.string(),
  callId: CallIdSchema,
  action: ActionType,
  target: TargetSchema,
  payload: z.record(z.string(), z.unknown()),
  evidence: z.array(z.string().min(1)).min(1),
});

export const ProposeResponseSchema = z.object({
  profile: z.literal(PROFILE),
  evaluationId: z.string(),
  status: z.literal("awaiting_receipts"),
  inputDigest: z.string(),
  proposals: z.array(ProposalSchema),
});

// The actual per-receipt entry inside the commit request body's `receipts` array
// (profile/operation/evaluationId/inputDigest are shared at the request level,
// per the spec's top-level commit envelope).
export const ReceiptEntrySchema = z.object({
  dossierId: z.string(),
  callId: z.string(),
  action: ActionType,
  accepted: z.boolean(),
  proposalDigest: z.string(),
  receiptId: z.string(),
  receiptSignature: z.string(),
});

export const CommitRequestSchema = z.object({
  profile: z.string(),
  operation: z.literal("commit"),
  evaluationId: z.string(),
  inputDigest: z.string(),
  receipts: z.array(ReceiptEntrySchema).min(1),
});

export const OutcomeSchema = z.object({
  dossierId: z.string(),
  callId: z.string(),
  action: ActionType,
  proposalDigest: z.string(),
  receiptId: z.string(),
  status: z.enum(["executed", "rejected"]),
});

export const CommitResponseSchema = z.object({
  profile: z.literal(PROFILE),
  evaluationId: z.string(),
  status: z.literal("completed"),
  inputDigest: z.string(),
  outcomes: z.array(OutcomeSchema),
});

export type Dossier = z.infer<typeof DossierSchema>;
export type Proposal = z.infer<typeof ProposalSchema>;
export type ReceiptEntry = z.infer<typeof ReceiptEntrySchema>;
export type Outcome = z.infer<typeof OutcomeSchema>;
