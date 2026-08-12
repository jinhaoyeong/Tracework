# Phase 5E final report

Status: closed at the frozen implementation checkpoint

```text
HEAD       c5a6b43cebf35fdb12e4c84019cf1d34486ec1a7
Repository main, clean before this documentation-only closeout
Provider calls during closeout 0
Production code changes 0
```

Phase 5E is complete enough to close. The deterministic pipeline, generation
transport, adjudicated-packet boundary, citation-marker validation, and a small
set of live broad-generation cases all passed. The remaining findings are
model-completeness observations, not reasons to change the retrieval or
generation architecture at this checkpoint.

## Executive result

| Area | Result |
| --- | --- |
| Scope classification and refinement | PASS |
| Facet discovery and decomposition | PASS |
| Per-facet retrieval and evidence union | PASS |
| Temporal/currentness reasoning | PASS |
| Provenance and conflict handling | PASS |
| Coverage and deterministic disposition | PASS |
| Unsupported-data refusal | PASS |
| Generation gating | PASS |
| Generation transport | PASS |
| Adjudicated claim serialization | PASS |
| Citation-marker resolution | PASS, marker validity only |
| Live broad generation | PASS WITH MODEL-QUALITY ISSUES |

The live model sometimes omitted packet-supported details, but none of the
final S1, S2, or S5 answers promoted excluded, proposed, superseded, pilot-only,
or future material into current August 2026 policy.

## Frozen production architecture

```text
question
  ↓
query-language scope classification
  ↓
evidence-derived scope refinement
  ↓
focused existing path OR synthesis path
  ↓
generic facet discovery
  ↓
independent per-facet retrieval
  ↓
union/rerank evidence reservoir
  ↓
temporal reasoning
  ↓
provenance/conflict reasoning
  ↓
requirement + proposition coverage
  ↓
deterministic disposition
  ↓
structured adjudicated synthesis packet
  ↓
one generation request when disposition = answer
  ↓
citation-marker validation
```

The scope boundary is explicitly two-stage:

```text
Stage 1: query-language breadth
  -> keep-focused or keep-synthesis as the initial route

Stage 2: evidence-derived refinement
  -> keep-focused
  -> keep-synthesis
  -> downgrade-to-focused
```

The first stage classifies wording and question shape. The second stage uses
discovered subjects and corpus evidence to confirm broad synthesis or return a
nominally broad, single-subject request to the focused path. The focused path
does not inherit synthesis retrieval, context, or generation behavior.

The final generation contract is:

```text
deterministic system adjudicates
model renders adjudicated claims
```

An answer-ready packet gives the model explicit current/applicable claims,
not-current claims, preserved exceptions, conflicts, and numbered references.
The model is not an independent coverage or evidence-sufficiency adjudicator.
Deterministic `partial-with-disclosure`, `hold-for-conflict`, and
`refuse-unsupported` outcomes remain local zero-call gates. `model-refusal`
remains a separate provider/model outcome.

## Deterministic results

The frozen offline baselines are:

```text
Step 6 union evidence recall       80/80
Step 6 selected evidence recall    68/80
Step 7 reasoning evidence recall   80/80

S1-S5 disposition                  answer
S6 disposition                     refuse-unsupported
S6 runtime obligations             8

Atlas genericity                   pass
Nimbus genericity                  pass
Focused controls F1-F5             pass
```

Increasing synthesis breadth did not bypass temporal validity, conflict and
provenance handling, unsupported-data detection, or provider gating. The
offline production path proved that S6 stops before generation with
`providerCalled = false` and `generationRequests = 0`.

## Step 10D generation-surface correction

The live diagnosis found a narrow generation-surface defect. Before Step 10D,
the deterministic S1 packet was answer-ready, but the model-facing context
contained no serialized adjudicated claims:

```text
S1 supported/current rows      0
S1 excluded/not-current rows   0
```

The generator therefore had to reconstruct claims from raw references and was
also exposed to evidence-sufficiency language that encouraged it to
re-adjudicate a decision already made by the deterministic pipeline.

After Step 10D, the same packet exposed:

```text
S1 current rows                35
S1 not-current rows            9
S1 exceptions                  10
```

The corrected surface serializes proposition status and currentness explicitly,
keeps exceptions attached to their facets, preserves the reference table, and
removes evidence-sufficiency re-adjudication from answer-ready synthesis. It
does not weaken citation validation or any deterministic zero-call gate.

## Final live validation

All final live cases used the existing model and generation route. Each made
one provider request, with no retries or extra cases. Local `/api/generate` and
upstream `/v1/responses` both returned HTTP 200.

### S1 - current-state synthesis

```text
disposition          answer
facets               11
current rows         35
not-current rows     9
exceptions           10
context              33,318 / 36,000
references           21
provider calls       1
HTTP                 200 / 200
generation           answered
citations            19 valid / 0 invalid
classification       PASS WITH MODEL-QUALITY ISSUE
```

The answer was broadly correct and preserved currentness distinctions. It used
slightly imprecise wording describing three main membership categories and
omitted the Bellweather University reassignment exception. No serious
currentness or status error was observed.

### S2 - four-plan comparison

```text
disposition          answer
required facets      4/4
current rows         55
not-current rows     0
exceptions           11
context              35,782 / 36,000
headroom             218
references           22
provider calls       1
HTTP                 200 / 200
generation           answered
citations            17 valid / 0 invalid
classification       PASS WITH MODEL-QUALITY ISSUE
```

Standard, Supported, Institutional, and Dayline remained separate. Major
exceptions, including the Bellweather University exception, were preserved.
Some Journey Guard and generic exception detail was omitted. The 218-character
headroom is a known boundary; evidence was not silently pruned and the 36,000
character contract was not changed.

### S5 - negative-status synthesis

```text
disposition          answer
required facets      10/10
current rows         1
not-current rows     11
context              21,958 / 36,000
references           13
provider calls       1
HTTP                 200 / 200
generation           answered
citations            11 valid / 0 invalid
classification       PASS WITH MODEL-QUALITY ISSUE
```

The answer correctly kept proposed Journey Guard and Standard values,
Meridian Flex, Meridian North, the adaptive-membership discussion, and other
negative-status material out of current policy. Several legitimate non-current
items were omitted. Those are completeness omissions, not a deterministic
pipeline failure or a status-preservation failure.

### S6 - unsupported metrics

```text
disposition          refuse-unsupported
runtime obligations  8
provider calls       0
classification       PASS
```

The complete frozen Meridian corpus was used for the offline production-path
check. The aggregate member-count and average-expenditure request was refused
before generation.

## Correctness boundaries

### Deterministic pipeline correctness

PASS. Scope, discovery, retrieval, temporal applicability, provenance and
conflict handling, proposition coverage, exceptions, currentness, and
unsupported-data gates were exercised offline. The broad route did not turn
retrieved but obsolete or proposed material into current evidence.

### Live transport correctness

PASS. The final S1, S2, and S5 requests reached the real Vite middleware,
`/api/generate`, OpenAI `/v1/responses`, and returned usable HTTP 200 responses
from `gpt-5.6-luna`. Each authorized case made exactly one provider request.

### Citation-resolution correctness

PASS for marker/reference resolution. The final answers contained 19, 17, and
11 valid citation markers respectively, with zero invalid markers. This check
proves that markers resolve to references in the structured packet. It does
not prove factual entailment, source truth, or that every supported proposition
was mentioned in the prose.

### Model-generation quality

PASS WITH MODEL-QUALITY ISSUES. The sampled answers were useful and preserved
the most important currentness and category distinctions, but they were not
complete renderings of every packet-supported detail. This is a model
completeness observation, not evidence that retrieval, temporal reasoning, or
coverage failed.

## Browser QA limitation

Step 10C-B remains partially verified rather than fully complete:

```text
Desktop focused -> synthesis       verified
Desktop synthesis -> focused       verified
Mobile focused -> synthesis        verified
Mobile synthesis -> focused        verified
Journey Guard downgrade            verified desktop/mobile
Journey Guard provider call        0
S6 refusal UI                      unverified
In-app Browser                     unavailable
Connected Chrome                   used
```

The S6 UI check was not recreated because the temporary browser fixture did not
contain the complete frozen Meridian corpus. One incorrect grounded-mode S6
attempt initiated a provider request and failed before receiving a response;
it was not retried and was not treated as live S6 validation. The actual S6
deterministic refusal is proven by the offline production-path regression.

## Known limitations

1. Citation validation proves marker/reference resolution, not factual
   entailment.
2. Model prose can omit packet-supported details even when deterministic
   coverage is complete.
3. The synthesis context budget is 36,000 characters.
4. S2 currently has only 218 characters of headroom.
5. Context pressure must not be solved by silently pruning adjudicated
   evidence or exceptions.
6. Browser QA was only partially completed; Connected Chrome was used because
   the in-app Browser was unavailable.
7. Model quality was sampled through a small frozen set, not statistically
   characterized across repeated samples or models.
8. The Meridian corpus is a single synthetic essay, so this closeout does not
   establish general multi-source synthesis quality.

## Future backlog - not implemented

- generation completeness evaluation across repeated samples/models;
- proposition-to-answer coverage metric;
- evidence-aware packet compression if context pressure becomes real;
- richer citation entailment and claim verification;
- broader synthesis families beyond Meridian.

These are future evaluation and product-hardening items. They are not changes
to the frozen Phase 5E implementation.

## Closeout accounting

```text
Frozen checkpoint       c5a6b43cebf35fdb12e4c84019cf1d34486ec1a7
Provider calls here     0
Production code changes 0
Architecture changes   0
Retries                 0
```

This report and the explicit scope-documentation clarification are the only
intended changes in this closeout. They are left uncommitted for review.
