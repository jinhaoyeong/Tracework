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

## 5. Frozen test set — **FROZEN**

Fixture text and expectations live in `scripts/fixtures/phase5d.mjs`, frozen
before the extractor exists. Each case freezes the expected **derived facts**
(subject, value, `validFrom`, `validUntil`, supersession relation, source), not
only the final answer, so a failure localises to a stage rather than reading
"T1 failed".

Applicability is evaluated at `requestedPeriod ?? asOf`: a question may name its
own period ("in 2024", "in February 2027"), and otherwise the injected `asOf`
applies.

### Supersession wording levels

| level | text | expectation |
| --- | --- | --- |
| explicit | "This supersedes all earlier pricing." | must resolve |
| natural | "The January 2025 rates replace what we published last year." | should resolve |
| awkward | "From January 2025 onward, customers used the new Team rate; the previous schedule remains in the archive." | **must not resolve** |

The awkward text is genuine human evidence of a version change that avoids every
decided trigger. **Its `unassessed` result is frozen as the correct answer.**
Widening the trigger list until it passes is the failure mode, not the fix.

One conflict in the instructions was resolved deliberately: "The January 2025
rates replace what we published last year" was proposed both as the awkward
unresolved case and as a positive case. It is frozen as **positive**, because
§4.5 already places "replaces" plus a date inside the decided trigger scope, and
freezing it as unresolved would contradict the extraction contract. The awkward
slot is filled by the trigger-free sentence instead.

### The nine cases

Fixtures and expectations are frozen **before** implementation. Cases 1–6 are
yours; 7–9 I am adding because they target the failure modes this design is most
likely to actually have.

| id | case | resolution | answer | reaches 5C |
| --- | --- | --- | --- | --- |
| T1 | current price, explicit supersession | resolved | 55 | no |
| T2 | historical price for a named period | resolved | 40 | no |
| T3 | unspecified time, evidenced currentness | resolved | 55 | no |
| T4 | 2026 note mentioning the former 40 | resolved | 55, never 40 | no |
| T5 | competing versions, no currentness evidence | **unresolved** | disclose | yes |
| T6a | future price, asked before it takes effect | resolved | 55, never 65 | no |
| T6b | future price, asked for its own period | resolved | 65 | no |
| T7 | **superseding evidence pruned** | resolved | 55, never 40 | no |
| T8 | version change, no decided trigger | **unassessed** | disclose | yes |
| T9 | two authoritative same-period claims | **unresolved** | conflict hold | yes |

Three of ten expectations are negative. A phase whose fixtures all pass by
answering is a phase that has learned to answer, not to know when it cannot.

**T7 is the flagship.** It is the direct analogue of the Phase 5C integration
result, and given the measured ranking it is the likeliest real failure. Its
variant includes the full 34-document padded corpus so the superseding source is
pruned on merit against real competition. **Whether it is genuinely pruned must
be verified during offline evaluation**; if it survives, add padding rather than
hand-placing the source into context, which would test only the resolver and
skip the integration path that matters.

**T9 proves authority ≠ automatic winner.** Two authoritative sources, same
subject, same period, no supersession between them: the temporal resolver cannot
choose, so it must hand over to Phase 5C rather than letting authority break a
tie it has no business breaking.

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

## 6b. Corrections made at step 8 — **DECIDED**

The offline evaluation changed two things the earlier sections got wrong. Both
are recorded here rather than quietly edited into the sections above.

### 6b.1 The temporal layer owns its own uncertainty

§3 said Phase 5C was "unchanged; receives what temporal resolution could not
settle", and T9 froze `expectedPhase5CStatus: conflicted`. Both cannot hold.
Phase 5C's extractor recognises **origin claims only** — it is gated on the
question containing `invented|created|built|founded|origin|where`. Handing it a
pricing disagreement returned `unassessed` ("No comparable claim pattern was
extracted"), so the handoff stopped nothing: `phase5cRequired` was computed by
the resolver and consumed by nobody. Every 5D case reported 5C `unassessed`.

Widening 5C to a generic subject/value extractor was rejected. That is a second
claim-understanding layer — units, scope, qualifiers, negation, ranges — adopted
only because 5D tried to give its result away, and it would forfeit the narrow
inspectable patterns 5C was built on.

So `phase5cRequired` is replaced by an orthogonal **disposition**:

```
status      resolved | unresolved | unassessed     what the evidence supports
disposition proceed  | hold                        whether generation may run
holdReason  multiple_applicable_propositions
            temporal_evidence_insufficient
            unestablished_subject
            unparseable_reference
            incomplete_temporal_evidence
```

Two fields, because `unassessed` does not always mean stop. "Where was Tracework
invented?" produces no temporal claims and is `unassessed` + `proceed`; gating on
status alone would refuse every ordinary question. A hold is for uncertainty the
temporal layer actually **detected**.

The gate order is unchanged and still load-bearing:

```
temporal coverage → temporal resolution → temporal gate
    hold  → local cited temporal answer, NO provider call
    proceed → Phase 5C adjudication
        conflict → local cited conflict answer, NO provider call
        otherwise → generation
```

Phase 5C remains available and unmodified for the contradictions it independently
understands. T5, T8 and T9 are now temporal holds, each with a distinct
explanation, because collapsing them would discard the distinction the extraction
contract exists to draw.

### 6b.2 T7 fixture correction

The T7 variant padded with the Phase 5A stress corpus, which contains
`pricing-2025.md` — a semantic duplicate of `t-pricing-2025.md`, carrying the
same subject, the same 55 USD value, the same 2025 validity and the same
supersession wording. The designated witness was genuinely pruned and genuinely
restored, but the no-coverage arm still resolved to 55 from the duplicate. T7
therefore proved *witness restoration* and never *answer rescue*, which is the
failure §3 describes.

The Phase 5D variant now excludes the two baseline pricing documents. Every other
distractor is kept, and the expected outcome is unchanged. This corrects an
experiment that contained a second copy of the evidence whose absence it was
meant to simulate; it is not benchmark tuning.

The budget is part of the experiment: with the duplicate gone `t-pricing-2025.md`
ranks third, so only `topK: 2` drops it. At 3+ nothing is pruned; at 1 the witness
pair cannot fit and the case must fail closed instead. T7 now asserts
`40 → 55`, the evidence lineage, and that the two arms differ.

### 6b.3 Coverage completeness

A supersession is proved by a witness **pair**. When the pair cannot fit the
budget, coverage records the shortfall (`complete: false`, named `omitted`
witnesses) and the gate holds with `incomplete_temporal_evidence`, rather than
leaving half a relation in context for the resolver to answer from. Recall must
never be bought with evidentiary completeness.

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
