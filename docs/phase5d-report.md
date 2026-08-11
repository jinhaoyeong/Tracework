# Phase 5D - temporal validity, supersession, and applicable authority

Recorded 11 August 2026. Phase 5D is complete through Step 10. The next
phase remains intentionally out of scope.

## Closure result

| Step | Result | Evidence |
| --- | --- | --- |
| 8 - offline evaluation | PASS | `docs/phase5d-evaluation.json`; zero provider calls |
| 9 - UI and inspector review | PASS | temporal inspector and `As of` control already accepted |
| 10 - scoped live validation | PASS | `docs/phase5d-live-classified.json`; five authorized cases |
| 11 - report | COMPLETE HERE | this report and preserved artifacts |

The large retrieval, reranker, and conflict benchmarks were not rerun.

## Before / after

The Phase 5D risk was not simply that a newer price existed. A superseding
witness could be retrieved before pruning, dropped from the normal context, and
leave the resolver with a stale but apparently grounded value. Temporal
coverage now analyzes the pre-pruning relations and restores the missing witness
before temporal resolution. An unresolved same-period authoritative conflict is
held locally before generation.

The live Step 10 contract now distinguishes two valid T7 paths:

```text
superseder pruned
  -> coverage restores it
  -> no coverage = 40, final = 55
  -> coverageMode = rescued

superseder survives normal pruning
  -> coverage adds nothing
  -> no coverage = 55, final = 55
  -> coverageMode = not-needed
```

The runner still fails when a pruned witness is not restored, when the final
temporal value is not 55, or when the generated answer/citation checks fail.

## Offline mechanism proof

The deterministic T7 forcing case remains the direct proof of the mechanism:

```text
before coverage:  t-pricing-2024.md + distractor context
without coverage: 40 USD per seat per month
coverage:         restores t-pricing-2025.md
after coverage:   55 USD per seat per month
```

`npm.cmd run test:temporal-coverage` passed, including the fail-closed
single-slot case. The frozen offline artifact records the same 40 -> 55 rescue
with no provider calls.

## Scoped live validation

The original provider run is preserved unchanged in
`docs/phase5d-live-success.json`. Its first classifier called T7 a coverage
failure because it required live neural retrieval to reproduce the deterministic
offline rank. That intermediate classification was revised without changing
the provider evidence or implementation logic.

The derived, zero-provider reclassification is
`docs/phase5d-live-classified.json`:

| Case | Temporal result | Disposition | Generation call | Result |
| --- | --- | --- | --- | --- |
| T1 current Team price | 55 | proceed | yes | PASS |
| T2 historical 2024 price | 40 | proceed | yes | PASS |
| T6b future February 2027 price | 65 | proceed | yes | PASS |
| T7 live superseder already retained | 55 | proceed | yes | PASS; `not-needed` |
| T9 simultaneous authority conflict | unresolved | hold | **no** | PASS |

T7 live evidence:

```text
reranked superseder: #2
normal context budget: 2
before coverage context: t-pricing-2024.md, t-pricing-2025.md
coverage added: none
coverageRescueObserved: false
no-coverage resolution: 55
final answer: 55 with citation to t-pricing-2025.md
```

The classified artifact records `finalOutcome=PASS`,
`coverageMode=not-needed`, `coverageRescueObserved=false`, and
`offlineCoverageRescueProven=true`. This is a live system result, not a claim
that the rescue path happened live.

T9 is the strongest gate result: retrieval and temporal analysis found two
applicable authoritative prices, relevance remained true, the disposition was
`HOLD`, and `providerCalled=false`.

## Usage and boundaries

The original five-case run used four generation calls (T9 was held locally),
2,044 generation input tokens, 137 output tokens, five embedding requests,
40 embedded texts, and 1,256 embedding prompt tokens. Reclassifying the saved
artifact used zero provider calls.

No retry, exploratory call, bulk re-embedding, or broad benchmark was performed.
The existing `src/App.tsx` and `src/styles.css` worktree edits remain outside
the Phase 5D scope and were not staged.

## Verification

- `node --experimental-strip-types --check scripts/live-phase5d.mjs`
- `node --experimental-strip-types --check scripts/phase5d-live-report.mjs`
- `npm.cmd run check`
- `npm.cmd run test:temporal-coverage`
- `npm.cmd run report:phase5d-live` with the saved live artifact
- `git diff --check`

The scoped runner changes and evidence are ready for the publication decision.
No push was performed here. Stop before Phase 5E.
