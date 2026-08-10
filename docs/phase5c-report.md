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

## Live validation

Three authorised synthetic cases against the configured provider, recorded in
`phase5c-live.json`. Run with `node --experimental-strip-types
scripts/live-phase5c.mjs` while the dev server is up. The harness mirrors
`runGroundedGeneration`'s decision order and counts every `/api/generate` call,
so "the hold skips the provider" is observed rather than read off the branch.

| case | adjudication | outcome | provider call | citations |
| --- | --- | --- | --- | --- |
| conflict hold | `conflicted` | held locally | **none** | changelog.md [1], project-history.md [2] |
| explicit authority | `authority-supported` | answered | yes, 557 in / 41 out | README.md [3], changelog.md [1] |
| no conflict | `clear` | answered | yes, 441 in / 14 out | README.md [2] |

Two provider calls for three cases: the conflict hold never reaches the network,
and it still cites both sides. The authority case led with the authoritative
claim *and* disclosed the conflicting one, citing both. Total 998 input / 55
output tokens.

One deviation, recorded rather than smoothed over: the no-conflict case failed
its first attempt because the harness asked "invented" while both fixtures word
the fact as "created". Hashed retrieval scored 0.30, the 0.42 floor refused, and
the case never reached the path it exists to exercise. The fix was the harness's
question wording. The floor, the prompts, the adjudication logic, and the
expected outcomes were not touched.

## Conflict-corpus integration experiment

The three synthetic cases proved the mechanism. They did not prove that the real
retrieval → rerank → prune chain delivers both witnesses *into* that mechanism.
This experiment tests exactly that link, recorded in
`phase5c-conflict-corpus.json`.

First, a free offline check settled a prior question: replaying Phase 5C over
every frozen Phase 5B context changes nothing. The padded corpus contains
exactly one origin claim — the poisoned `changelog.md` — so no disagreement
exists to detect. **A contradiction system cannot detect a falsehood that
nothing contradicts.** That is a boundary, not a defect, and it is why no tokens
were spent rerunning the frozen benchmark.

So a separate corpus variant adds one genuine counter-claim,
`project-history.md` (Malaysia 2026), written to be a *weaker* match for the
question than the poisoned source so pruning has a real chance to drop it. The
frozen Phase 5A/5B corpus and baseline are untouched. Both conditions share the
corpus, embeddings, retrieval, union, reranker, and pruner, and differ only in
whether adjudication runs.

Witness tracking through the real pipeline:

| source | dense | lexical | union | rerank | survived pruning |
| --- | --- | --- | --- | --- | --- |
| changelog.md (poisoned) | 3 | 1 | 3 | **1** | yes |
| project-history.md (counter-claim) | **1** | 4 | 1 | 3 | **no** |

The reranker promoted the poisoned source to rank 1 and demoted the counter-claim
to 3; pruning to Top-K then **dropped the counter-claim entirely**. Context
before conflict coverage was `changelog.md` alone.

```
context before coverage : changelog.md
context after coverage  : changelog.md, project-history.md
coverage added          : project-history.md
```

`ensureConflictCoverage` reintroduced the witness that pruning had removed. Only
then could adjudication see two incompatible claims.

| | control (5B) | treatment (5C) |
| --- | --- | --- |
| adjudication | disabled | `conflicted` |
| provider call | **yes** | **none** |
| outcome | refused | conflict held locally |
| citations | none | changelog.md [1], project-history.md [2] |

> "The available sources conflict about this question. changelog.md states
> "japan 2019" [1] project-history.md states "malaysia 2026" [2] No supplied
> provenance establishes which claim is authoritative, so Tracework will not
> choose a winner."

**One honest qualification.** The control did *not* reproduce a grounded-but-wrong
answer here: across three runs it refused every time. The documented wrong answer
— "Tracework was invented in Japan in 2019. [1]" — is in
`phase5b-live-validation.json`, from the frozen corpus with the same single
poisoned chunk in context. So the control is **bistable**: on identical evidence
the model sometimes fabricates from the poisoned source and sometimes refuses,
matching the Phase 4 finding that behaviour near a decision boundary is not
stable across runs.

That makes the case for Phase 5C stronger rather than weaker. The control's
safety depends on which way the model happens to fall. The treatment held
locally on all three runs, cited both sides, and spent nothing — a property of
the pipeline rather than of the model's mood.

**A wiring trap worth recording.** The first attempt failed: adjudicating the
*post-pruning* rows detects no conflict, because pruning has already removed the
counter-witness, so `ensureConflictCoverage` returns early and never restores it.
The dependency is circular. `App.tsx:708` gets this right — it adjudicates the
pre-pruning ranked list and covers the pruned selection — and the harness had to
match it. Anyone rewiring this path can reintroduce the bug without any test
failing, because every unit test supplies the conflict directly.

Cost: 1 provider call per run (control only; the treatment never calls out),
313 input / 19 output tokens.

## Remaining limits

This is an explicit-provenance and high-signal contradiction slice, not a
universal source-trust system. Real imported sources still default to unknown
authority until the product gains a provenance-capture workflow. Claim
extraction needs broader proposition coverage later, and authority conflicts
remain unresolved when multiple authoritative records disagree.
