# Phase 5C — source trust and contradiction handling

Recorded 10 August 2026. Phase 5A and Phase 5B artifacts remain frozen. Phase
5C adds an explicit evidence-adjudication boundary after retrieval/reranking
and before grounded generation; it does not change relevance scores, RRF,
recency, pricing, or arithmetic behavior.

## Boundary

```text
dense + lexical retrieval
        union / rerank / prune
        claim extraction
        provenance inspection
        contradiction detection
        conflict witness preservation
        grounded answer or conflict hold
```

The boundary is `adjudicateEvidence(question, results)`. It returns extracted
claims, source provenance, incompatible claim groups, an evidence status, and a
human-readable notice. It deliberately has no trust score and never lets
majority, repetition, or relevance choose a winner.

## Provenance model

Documents can now carry optional metadata:

- origin: user note, indexed file, synthetic fixture, or unknown;
- authority: unknown, declared, or authoritative;
- basis: the explicit reason supplied by the indexer.

Existing documents remain valid. Missing metadata is represented as unknown,
not silently promoted from a filename or source kind.

## Claim model

The first transparent extractor recognizes only high-signal propositions:

- project origin statements such as “created in Malaysia in 2026”;
- direct current Elasticsearch-use statements, including explicit negation.

Unknown language remains unassessed. Meeting proposals and rejected proposals
are not treated as current positive use claims. This keeps Phase 5C narrow and
inspectable instead of pretending to be a general truth detector.

## Q9 results

The unresolved fixture contains:

- `changelog.md`: Japan, 2019; authority unknown;
- `project-history.md`: Malaysia, 2026; authority unknown.

Phase 5C extracts both claims, reports one conflict, preserves both witnesses
for context, and holds grounded generation with an explicit conflict answer.
It does not answer Japan or Malaysia.

The authority fixture adds `README.md` with explicit authoritative provenance
for Malaysia, 2026. The adjudicator changes only to `authority-supported`; it
does not use a vote or a relevance threshold to resolve the conflict.

The machine-readable evaluation is in `docs/phase5c-evaluation.json`.

## Grounded handoff

The context now includes an `EVIDENCE STATE` metadata block. For unresolved
conflict, Tracework does not call the generation model: it returns a cited,
deterministic conflict disclosure. For an explicit authoritative record, the
normal grounded-generation path remains available and receives instructions
to disclose the competing claim.

The UI exposes:

- extracted claims;
- conflict count and status;
- authority records and their basis;
- context witnesses preserved for grounding;
- source-level provenance in the inspector.

The Phase 5C conflict fixture can be loaded from the capture rail without
modifying the existing synthetic workshop set. A second control adds the
explicit authoritative README variant so the resolution boundary is visible
in the UI rather than only in the offline test.

No external provider request is part of this phase. Unresolved conflicts are
held locally before generation; the authority-supported path is passed through
the normal generation boundary when a provider is configured.

## Verification

- `npm.cmd run test:adjudication`
- `npm.cmd run test:grounded`
- `npm.cmd run test:retrieval`
- `npm.cmd run test:reranker`
- `npm.cmd run check`
- `npm.cmd run eval:phase5c`
- `npm.cmd run stress:grounded -- --strict` (19/19)
- `npm.cmd run build`
- `git diff --check`

Browser validation confirmed the unresolved fixture renders a conflict hold
with both witness citations, and the authority variant renders one explicit
authority record with an `authority supports one claim` state.

Phase 5D recency/supersession and Phase 5E arithmetic/composition are not part
of this phase.

## Remaining limits

This is an explicit-provenance and high-signal contradiction slice, not a
universal source-trust system. Real imported sources still default to unknown
authority until the product gains a provenance-capture workflow. Claim
extraction needs broader proposition coverage later, and authority conflicts
remain unresolved when multiple authoritative records disagree.
