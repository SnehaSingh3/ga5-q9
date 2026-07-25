# Mailroom Agent (ga5-mailroom-action-gate/v2)

Single Vercel serverless endpoint implementing the exact `propose`/`commit`
contract from the assignment.

## ⚠️ One unconfirmed detail: receipt signature payload

The spec gives the receipt fields and says "first verify every
`receiptSignature`" and "a receipt is scoped to its evaluation, proposal
digest, and call ID" — but it never states the exact byte sequence that's
signed. `lib/crypto.ts` verifies against the canonical (key-sorted, compact)
JSON of `{evaluationId, dossierId, callId, action, accepted, proposalDigest,
receiptId}`.

**Before your real Check run**, do a dry run against the actual grader (or
a sample it provides) and confirm this verifies. If it doesn't:
1. Temporarily log the raw receipt object and the constructed message in
   `handleCommit` (never log this against real graded evaluations — only
   scratch/sandbox runs).
2. Try alternate scopes (e.g. drop `action`, add `profile`/`inputDigest`,
   or only sign `proposalDigest + receiptId`).
3. Once it verifies, update `receiptSignedMessage` in `lib/crypto.ts` and
   remove the debug logging.

Because verification fails *closed* (rejects rather than accepts on
mismatch), getting this wrong makes the endpoint safe but non-functional —
not unsafe — so it's a good first thing to test end-to-end.

## Setup

```bash
npm install
npm install -g vercel   # if you don't have the CLI
```

## Environment variables

| Variable | Purpose |
|---|---|
| `UPSTASH_REDIS_REST_URL` | From an Upstash Redis free-tier database |
| `UPSTASH_REDIS_REST_TOKEN` | From an Upstash Redis free-tier database |
| `MODEL_API_URL` | Defaults to OpenAI chat completions; override for another OpenAI-compatible provider |
| `MODEL_API_KEY` | Your model provider API key |
| `MODEL_NAME` | Defaults to `gpt-4o-mini` |

### Getting Upstash Redis (free)
1. https://console.upstash.com → create a Redis database (pick a region close to your Vercel deployment region).
2. Copy the REST URL and REST token into your Vercel project's env vars.

## Deploy

```bash
vercel          # first time, links/creates the project
vercel --prod   # deploy to production
```

Submit the resulting URL, e.g. `https://mailroom-agent-yourname.vercel.app/api/mailroom` — no credentials, query string, or fragment, matching the requirement.

## What's implemented

- **`inputDigest`**: SHA-256 over UTF-8 bytes of the `dossiers` array,
  recursively key-sorted, compact JSON, array order preserved — exactly per
  spec (`lib/hash.ts: computeInputDigest`).
- **`proposalDigest`**: computed only from `{dossierId, callId, action,
  target (null if absent), payload, evidence (sorted)}`, no extra fields —
  exactly per spec (`lib/hash.ts: computeProposalDigest`).
- **`callId`**: generated per proposal, 12–128 chars, charset
  `A-Za-z0-9._:-`, never reused (`freshCallId` in `api/mailroom.ts`).
- **Ed25519 receipt verification** (`lib/crypto.ts`) — see the caveat above
  about the exact signed payload.
- **Caching by canonical dossier content, not evaluationId**: a dossier's
  decision (action/target/payload/evidence) is cached under its content
  fingerprint, so repeated Checks with new evaluationIds/auditIds reuse the
  decision and only get a fresh `callId` minted, without a new model call.
- **Exact propose replay**: same `evaluationId` + `dossierId` returns the
  stored proposal (same `callId`) without recomputation.
- **Exact commit replay**: same `receiptId` returns the stored outcome
  without re-marking the effect as executed.
- **Content conflict → 409**: same `evaluationId` with a different
  `inputDigest` (propose) or mismatched `inputDigest` at commit time.
- **Receipt scoping enforcement**: a receipt is only honored if its
  `callId`, `action`, and `proposalDigest` match the persisted proposal for
  that `evaluationId` + `dossierId` — never accepted against another
  proposal.
- **Schema validation before AI/tool work**: malformed requests, wrong
  `profile`, duplicate dossier IDs → 400/422 immediately, no model call.
- **Evidence = lineIds**, validated against the dossier's actual
  `sources[].lines[].lineId` values; unknown IDs are filtered before
  hashing/storing so a malformed model response can't corrupt the digest.
- **Fail-closed model handling**: if the model's output doesn't parse into
  a valid action, that dossier is quarantined with a real (not invented)
  `lineId` as evidence rather than defaulting to something riskier.
- **Prompt-injection resistant system prompt** (`lib/model.ts`): line text
  is framed as data, never instructions; trusted quotes of attack language
  aren't auto-flagged; minimal-evidence citation is enforced in the prompt.
- **Response size bound**: responses over 512 KiB rejected rather than
  silently truncated.

## What's still a stub / needs your attention

1. **Confirm the receipt signature payload** — see warning above. This is
   the single highest-risk unknown.
2. **Real side-effect execution** in `handleCommit` — currently records
   `executed` after the dedup/signature/scope checks pass, but doesn't
   actually write anywhere. Wire in whatever "create a draft" /
   "update an internal record" / "send a notice" means for your actual
   downstream system (the spec doesn't require a real mailbox — check
   whether the grader just wants durable *recording* of the outcome, which
   is what this already does).
3. **Timeout handling** — wrap the model call in an `AbortController` with
   a budget safely inside your 55s per-request window, especially since a
   propose request can contain many uncached dossiers in one batch.
4. **Batching strategy** — right now all uncached dossiers in one propose
   call go to the model in a single request. With 64+ dossiers at ~70–75k
   input tokens total, you may want to chunk this into a few parallel
   model calls to stay well within the time budget, then merge results.
5. **Retry logic** for transient model API failures.
6. **Test replay/conflict/malformed paths without calling the model** — the
   code already short-circuits before `decideBatch` for all of these, but
   write actual test requests against your deployed endpoint to confirm.
