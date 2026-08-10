# Phase 5D plan — temporal validity, supersession, and applicable authority

Planning document. No implementation. Frozen decisions are marked **DECIDED**;
open ones are marked **NEEDS YOUR CALL** and should be settled before code.

## 1. Objective

Teach Tracework that two sources stating different values for the same fact are
not necessarily in conflict — they may be different versions valid at different
times — and that answering correctly requires knowing *which time the question
is about*.

```
What fact?  +  Valid when?  +  What supersedes what?  +  Which applies at the asked-for time?
```

**Non-goals.** Phase 5D does not introduce ingestion-supplied temporal fields,
does not touch Phase 5B ranking, and does not change Phase 5C contradiction
semantics. It adds a resolution layer *in front of* contradiction handling.

## 2. Where temporal facts come from — **DECIDED**

Claim level, extracted from text, normalised into **derived** metadata that
keeps its evidence trail.

```
pricing-2025.md: "Tracework pricing, revised January 2025. This supersedes all
                  earlier pricing. The team plan costs 55 USD per seat per month."
        ↓ temporal extraction
{
  subject: 'team-plan-price',
  value: '55 usd per seat per month',
  validFrom: '2025-01',
  validUntil: null,
  supersedes: { target: 'earlier-pricing', kind: 'class' },
  basis: 'text-extracted',
  evidence: { source: 'pricing-2025.md', chunkId, sentence: 'This supersedes all earlier pricing.' },
}
```

Adding `valid_from` / `superseded_by` as authored fields on every source would
be Phase 6 schema design pulled forward, and would hand the benchmark its own
answer. The corpus already contains the interesting signal as prose; learning to
read it is the experiment.

**Two namespaces, never merged:**

| source metadata (authored, Phase 5C) | derived temporal metadata (Phase 5D) |
| --- | --- |
| title, path, createdAt, kind, explicit `authority` | validFrom, validUntil, supersedes, supersededBy, version |
| supplied at ingestion | extracted from evidence, always carrying its sentence |

Phase 6 later feeds structured metadata into the *same* resolver. Authored
metadata may **constrain or strengthen** a derived claim; it must never silently
replace it, and the evidence trail survives either way.

## 3. Pipeline placement

```
retrieval → union → rerank → prune
        ↓
temporal claim extraction   (over the PRE-pruning ranked pool)
        ↓
supersession-witness coverage   (restore superseding evidence pruning dropped)
        ↓
temporal resolution at asOf
        ↓
Phase 5C contradiction handling   (unchanged; receives what temporal resolution could not settle)
        ↓
generation or local hold
```

**Ordering is load-bearing, and Phase 5C already taught us why.** Adjudicating
after pruning was circular: pruning removed the witness whose absence then hid
the conflict. The identical trap exists here and is *more* likely to fire —
Phase 5A measured `pricing-2024.md` outranking `pricing-2025.md` on Q1, Q2 and
Q10. **The superseding document is the one that ranks lower.** If pruning keeps
the top chunk only, the resolver sees the 2024 claim alone and confidently
answers $40 to "what is the current price?" — a grounded, cited, wrong answer,
with no conflict detected because nothing contradicts it in context.

So Phase 5D needs its own coverage step, analogous to `ensureConflictCoverage`:
when a claim is superseded by evidence outside the pruned context, that evidence
must be restored before resolution. **Test 7 below exists to force this.**

## 4. Resolution semantics

### 4.1 The `asOf` clock — **DECIDED**

Resolution takes an explicit `asOf` timestamp. It is never read from
`Date.now()` inside the resolver, defaults at the call site, and is recorded in
every artifact.

Reading the wall clock would make "what is the current price?" produce different
answers on different days and would make Test 6 unreproducible — the same class
of defect as the random fixture ids that put benchmark noise into every earlier
comparison.

### 4.2 Applicability

A claim applies at `asOf` when `validFrom <= asOf` and (`validUntil` is null or
`asOf <= validUntil`). Claims with unparseable or absent temporal bounds are
`undated`, never assumed current.

### 4.3 Supersession

`supersedes` is a relation between **claims**, not documents. A newer document
may restate an old claim (Test 4), and an old document may announce a future
one (Test 6).

Class-level targets ("supersedes all earlier pricing") resolve to: every claim
with the same `subject` whose `validFrom` is strictly earlier. A superseded
claim is not deleted — it remains answerable for its own period (Test 2).

### 4.4 Frozen precedence

```
1. Retrieve / rerank a broad enough candidate pool
2. Extract claims + temporal relations from PRE-pruning candidates
3. Determine the requested asOf
4. Temporal applicability resolution
5. Preserve required temporal witnesses (ensureTemporalCoverage)
6. If temporal relations explain the differing values -> resolve by applicability
7. If multiple applicable claims still disagree -> Phase 5C, unchanged
8. If neither temporal nor authority evidence resolves it -> disclose / hold
9. Build generation context
```

Two inequalities carry the phase:

```
authority ≠ applicability    an authoritative 2024 price does not beat an
                             authoritative 2025 price when asking about 2026
recency   ≠ applicability    a 2026 document mentioning the former 2024 price
                             does not make $40 current
```

A superseded claim is never deleted; it remains answerable for its own period.

### 4.5 Extraction scope — **DECIDED**

Narrow and declared, as in Phase 5C. A small set of transparent patterns:
explicit revision dates, "supersedes"/"replaces"/"effective from"/"starting
<date>", and "former/previous/old <value>" as an explicit historical marker.
Anything else yields `unassessed`, which must never be read as "no temporal
relationship exists."

## 5. Frozen test set

Fixtures and expectations are frozen **before** implementation. Cases 1–6 are
yours; 7–9 I am adding because they target the failure modes this design is most
likely to actually have.

| # | case | question | expected |
| --- | --- | --- | --- |
| 1 | current | "What is the current Team plan price?" | $55, citing 2025 + the supersession sentence |
| 2 | historical | "What did the Team plan cost in 2024?" | $40, citing 2024 |
| 3 | unspecified | "How much is the Team plan?" | $55 — but see 6.2 |
| 4 | newer doc, old claim | 2026 note mentions "the former $40 price" | must **not** supersede $55 |
| 5 | two current claims | two authoritative sources, $55 vs $60, no supersession | Phase 5C conflict hold |
| 6 | future price | 2026 notice: "starting January 2027 the price will be $65" | current → $55; "in February 2027" → $65 |
| 7 | **superseding doc pruned** | current price, with `pricing-2025.md` ranked below the pruning cut | coverage restores it; answer $55, not $40 |
| 8 | **supersession without a date** | "this supersedes earlier pricing" with no period anywhere | must not resolve; disclose rather than guess |
| 9 | **newer authoritative vs older authoritative, same period** | both authoritative, both applicable | Phase 5C hold — authority does not break a temporal tie |

Test 7 is the flagship. It is the direct analogue of the Phase 5C integration
result, and given the measured ranking it is the likeliest real failure.

## 6. Settled decisions — **DECIDED**

**6.1 Class-target supersession: allowed, subject-scoped and inspectable.**
"Supersedes all earlier pricing" may expand into concrete relations only when
*all* hold: same normalised subject (plan, currency, unit, scope), explicit
supersession language, an identifiable target class, and a strictly earlier
`validFrom`. A sentence about the Team plan subscription price must not
invalidate an enterprise installation fee. The expansion is shown in the
inspector — original sentence, expanded targets, and the reason each was
included — so the reach of one sentence is visible rather than implied. An
ambiguous subject yields `unresolved`, never a guess.

**6.2 Unspecified time: currentness must be evidenced.** Resolve only when one
claim is applicable at `asOf`, or when explicit currentness/supersession
language identifies the applicable version. There is **no latest-`validFrom`
default** — that is "newest wins" wearing a different name. With two dated
prices and no supersession evidence, Tracework discloses that multiple versions
exist and that nothing establishes which is current. This will sometimes refuse
where a human would infer the newer version; that gap is the point of the
experiment.

**6.3 `asOf`: visible reference-date control, resolved once at the call site.**
The resolver requires an injected `asOf` and must never call `Date.now()`.
Benchmarks always pass a fixed date. The UI offers `As of: [ Now ▾ ] [ date ]`,
defaulting to Now, which resolves at the call site into an immutable timestamp
for the whole query. `asOf` is recorded in every result and artifact. This makes
Test 6 demonstrable by changing one control: *as of Aug 2026 → $55*, *as of
Feb 2027 → $65*.

**6.4 Coverage functions stay separate.** `ensureConflictCoverage` and
`ensureTemporalCoverage` remain distinct rather than collapsing early into a
generic `ensureEvidenceCoverage`. They preserve evidence for different reasons —
one so a disagreement stays visible, one so an obsolescence stays visible — and
the common abstraction should be discovered, not assumed.

## 7. Anti-rules

Never: newest file wins · largest year wins · `createdAt` ordering · version
string comparison · hidden temporal score · majority voting. Each fails on
Test 4, where a 2026 document mentions a 2024 price.

## 8. Measurement plan

Offline first, exactly as Phase 5C: run the full fixture set with no provider
calls, verify claim extraction, coverage, and resolution, and only then request
authorisation for a small live validation. The Phase 5C dry run saved a pointless
spend by proving offline that the outcome could not change; the same discipline
applies here.

Record per case: extracted temporal claims with their sentences · resolved
`validFrom`/`validUntil` · supersession relations and their evidence · context
before and after supersession coverage · `asOf` · resolution outcome · whether
Phase 5C was reached · provider call yes/no · citations · correctness.

**Artifact observability (do first, it is small):** report generation and
embedding usage separately — generation requests / input / output tokens,
embedding requests / texts embedded, and a total. Current artifacts report
generation only, so the Phase 5C figure of 313 in / 19 out omits the embedding
work entirely.

## 9. Sequence

| | step | provider access |
| --- | --- | --- |
| 1 | Embedding usage observability | none — **done** |
| 2 | Freeze decisions 6.1–6.4 | none — **done** |
| 3 | Freeze fixtures for cases 1–9 | none |
| 4 | Narrow temporal extractor | none |
| 5 | Normalise into derived metadata | none |
| 6 | Temporal resolution at `asOf` | none |
| 7 | `ensureTemporalCoverage` | none |
| 8 | Offline evaluation | none |
| 9 | UI inspection (`As of` control, expansion display) | none |
| 10 | Small authorised live validation | **requires authorisation** |
| 11 | Document, commit, push | none |
| 12 | Stop before Phase 5E | — |

Steps 3–9 need no provider access at all. Following the Phase 5C pattern, step 8
must show what the live run would prove *before* step 10 is requested: the
offline dry run there saved a pointless spend by demonstrating the outcome could
not change.
