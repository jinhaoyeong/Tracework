# Phase 5B — candidate union, relevance reranking, and context pruning

Recorded 10 August 2026. Phase 4 and Phase 5A artifacts were not modified.
The ranking numbers below are an offline replay over the frozen Phase 5A padded
dense candidates in `docs/phase5a-padded.json`, with the unchanged local BM25
implementation. This isolates Phase 5B from provider drift and costs zero
model tokens. The live provider run is implemented, but the local embedding
proxy returned `proxy_error` before it reached the provider in this environment.

## 1. Files changed

| file | change |
| --- | --- |
| `src/lib/reranker.ts` | Candidate union, metadata-preserving deduplication, deterministic relevance reranker, and separate pruning boundary. |
| `src/types.ts` | Adds the `rerank` retrieval-engine label. |
| `src/App.tsx` | Adds the Phase 5B engine and inspection mode without removing dense/lexical/RRF controls. |
| `src/styles.css` | Tracework-styled Phase 5B controls, five raw/derived inspection lists, rejection log, and inspector details. |
| `scripts/test-reranker.mjs` | Union, dedupe, ordering, tie, metadata, poisoned-source, and pruning tests. |
| `scripts/eval-reranker.mjs` | Live provider benchmark plus `--offline` frozen-candidate replay. |
| `scripts/fixtures/phase5b.mjs` | Five DEV questions and the unchanged ten-question EVAL set. |
| `docs/phase5b-padded-offline.json` | Recorded offline Phase 5B candidates, rankings, pruning decisions, and metrics. |
| `package.json` | Adds `test:reranker` and `eval:reranker`. |

The existing `docs/phase4-*`, `docs/phase5a-*`, `scripts/eval-retrieval.mjs`,
BM25 implementation, RRF default (`k=60`), generation prompt, refusal
classifier, and citation validation were left unchanged.

## 2. Candidate union design

The candidate pool is built from dense Top-10 plus lexical Top-10. It is
deduplicated by chunk ID and never computed from RRF. Each union row keeps:

- dense rank, similarity, and distance;
- lexical rank, raw BM25 score, field hits, and matched terms;
- whether it came from dense, lexical, or both;
- the original union position and the original `SearchResult` metadata.

The union’s first-seen order is dense-first followed by lexical-only rows. That
is an inspection order, not a hidden relevance rank. Full-union presence is the
more meaningful measurement; the “Union” row in the table is its stable first
five-row window.

## 3. Reranker design

The boundary is:

```text
rerank(question, candidates) -> RankedCandidate[]
```

The shipped `transparent-v1` strategy is deterministic and inspectable. Its
score uses only question/passage relevance signals:

```text
body coverage       0.40
title/path coverage 0.14
exact title/path    0.16
phrase coverage     0.05
dense signal        0.10
lexical signal      0.15
```

Every row exposes the feature values, relevance label, reason, union rank,
dense rank, lexical rank, and new rank. It does not inspect source authority,
dates, contradiction, source kind, or truth. Q9 is therefore expected to rank
high: relevance is not trust.

## 4. Pruning design

Pruning is a separate `pruneCandidates` call. It keeps candidates at or above
the 28% relevance floor, rejects rows more than 32% below the best relevance
score, and caps the context at five rows. It does not fill empty slots. Every
rejected row retains a reason such as “below relevance floor” or “more than
32% below the best relevance score.”

The UI can turn pruning off. With pruning off, the full reranked pool remains
available to the generation context; with it on, the selected count and
rejection log are visible independently of the reranked list.

## 5. DEV / EVAL separation

The ten existing stress questions remain frozen EVAL questions. Five new DEV
questions cover deployment, chunking, security, retrieval definitions, and
embedding-dimension changes. No constant was selected by rewriting the frozen
questions or modifying their expected sources. In the offline replay, EVAL
dense candidates come from the frozen Phase 5A snapshot; DEV dense candidates
use a clearly labelled local hashed proxy because no live embedding provider
was available.

## 6. Retrieval and selection metrics

Frozen EVAL questions with expected sources: 7 of 10. Context ratios include
all ten EVAL questions; `relevant` follows the existing fixture’s retrieval
judgement and is not a truth label.

```text
                         R@1     R@5      MRR      relevant/context   chunks   distractors
Dense                    4/7     6/7    0.7143          0.3200          5.0        3.4
Lexical                  4/7     6/7    0.6905          0.3000          5.0        3.5
RRF                      4/7     5/7    0.6429          0.3200          5.0        3.4
Union before rerank      4/7     6/7    0.7143          0.3200          5.0        3.4
Union + rerank           5/7     6/7    0.7857          0.3200          5.0        3.4
Union + rerank + prune   5/7     6/7    0.7857          0.6333          2.3        0.9
```

The full candidate union contained all 7/7 expected scored sources. Reranking
versus dense improved one question, worsened one, and left five unchanged.
Pruning changed no expected-source rank in this replay, but it did reduce the
context substantially. Q10’s expected source was already pushed to rerank
rank 7, so it is recorded as an accidentally pruned expected source rather
than being hidden by the aggregate table.

DEV results are recorded separately in the JSON artifact. They are a tuning
check, not evidence for changing the frozen benchmark.

## 7. Focus questions

### Q8 — onboarding

The correct `onboarding.md` was lexical rank 1 but union position 11 because
the raw union preserves dense rows first. Reranking moved it to rank 1, and it
entered the pruned context at citation position 1. This is the primary Phase
5B success: the lexical-only evidence survives long enough for a relevance
decision to see it.

### Q3 — negation trap

`architecture.md` stayed rank 1 for dense, lexical, RRF, union, rerank, and
pruned context. The reranker also kept `meeting-notes.md` near the top because
it shares the direct Elasticsearch wording. No negation rule was added. The
remaining contradiction problem is not solved by relevance alone.

### Q9 — poisoned changelog

The relevance reranker moved `changelog.md` to rank 1 and pruning selected only
that direct answer. This is the expected danger result: the source is highly
relevant to “Where was Tracework invented?” even though the claim is poisoned.
The experiment did not special-case it or smuggle in source trust.

### Pricing

- Q1 still placed `pricing-2024.md` ahead of `pricing-2025.md`; recency is not solved.
- Q2 correctly kept the 2024 source first.
- Q5 kept `pricing-2025.md` first.
- Q10 had `pricing-2025.md` in the union at rank 2, but relevance-only reranking pushed it to rank 7 because the question asks for an annual ten-seat calculation rather than repeating the source’s wording. It was therefore absent from the pruned context.

This is a relevance/arithmetic and recency boundary, not a reason to add date
logic to Phase 5B.

## 8. Live generation validation, cost, and acceptance boundaries

The focused live pass used the frozen Phase 5B ranking and pruning locally,
then sent only the five selected contexts to `/api/generate`. It made no live
embedding or vector-database calls. The run used the configured `gpt-5.6-luna`
model and current generation settings. The complete record is in
`docs/phase5b-live-validation.json`.

```text
ID   rerank / selected              outcome    correct   citations                         input  output
Q8   onboarding.md #1 / 3 chunks    answered   yes       onboarding.md                    530    36
Q3   architecture.md #1 / 3         answered   yes       architecture.md, meeting-notes.md 518    41
Q9   changelog.md #1 / 1             answered   no        changelog.md                     268    18
Q10  pricing-2025.md #7 / 0          refused    yes       none                               0     0
D1   deployment-guide.md #1 / 1      answered   yes       deployment-guide.md              258    23
```

The final run used 1,574 input tokens and 118 output tokens, 1,692 total.
Q10 was a deterministic insufficient-evidence refusal, so it made no provider
generation request and has no model name. The local response exposes token
usage but not account billing; no dollar cost is guessed here. Generation
wording and output tokens may vary, but the ranking and selected context were
the same as the offline replay for all five cases.

Verified locally:

- `npm.cmd run check`
- `npm.cmd run test:grounded`
- `npm.cmd run test:retrieval`
- `npm.cmd run test:reranker`
- `npm.cmd run stress:grounded --strict` — 19/19 checks passed
- `npm.cmd run build`
- `git diff --check`
- desktop and 390px browser inspection of the Phase 5B UI

The browser inspection covered control state, separate list rendering, pruning
state, and mobile width. The focused harness proved live grounded generation,
but not live embedding retrieval, native-app behavior, or publication.

## 9. Conclusion and remaining limitations

Once dense and lexical retrieval have found the evidence, reranking selected
better evidence in the replay: Q8 moved from absent in dense/RRF Top-5 to the
correct onboarding source at rank 1, while EVAL MRR rose from 0.7143 to 0.7857.
The focused live pass then confirmed the unchanged grounded-generation handoff
for the five high-value cases: four expected answers/refusals were correct and
Q9 remained the intentionally poisoned-source failure. Pruning improved
context concentration without improving rank metrics.

The remaining failures separate cleanly:

- relevance/selection: Q10’s arithmetic wording pushes the pricing source out;
- source trust: Q9’s direct false changelog remains attractive;
- contradiction handling: Q3 still needs proposition-aware comparison;
- recency/authority: Q1 can prefer 2024 over 2025;
- generation: the selected-context handoff is live-verified; full live neural
  retrieval and dollar billing remain outside this focused pass.

The reranker is intentionally a transparent heuristic, not a trained
cross-encoder. A future provider-backed reranker can replace the boundary, but
source trust, recency, and contradiction should remain separate phases.
