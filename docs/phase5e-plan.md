# Phase 5E plan - compositional and broad synthesis

Planning document. This is the Step 1 evaluation and architecture contract only.
It changes no production behavior, makes no provider calls, and contains no
implementation. Decisions marked **FROZEN** are benchmark requirements. Known
limitations are recorded in section 10 and must not be silently designed away.

## 1. Motivation and baseline - **FROZEN**

Tracework's focused path turns one question into a small, ranked context. That
path has proved effective for focused, multi-hop, contradiction-aware, and
temporal questions. It is not a completeness mechanism for broad questions.

The forcing question is:

> Summarise Meridian as it existed in August 2026. Exclude obsolete,
> proposed, pilot-only, or future rules.

The reported Meridian evaluation answered focused questions 1-19 but produced
no answer for this broad question. The repository's local, provider-free
`test:meridian` baseline reproduces the evidence-coverage failure:

```text
source chunks          29
union candidates       14
selected chunks         3

selected topics
Standard, Quiet Month, Journey Guard

missing topics
Supported, Institutional, Dayline, Continuity Credit
```

The answer key is not embedded in the Meridian source. The baseline therefore
shows a retrieval/context coverage failure, not answer-key leakage.

Phase 5E teaches a second query path:

```text
focused QA
question -> existing retrieval/reasoning path -> answer

broad synthesis
question -> facets -> evidence for each facet -> per-facet reasoning
         -> explicit coverage decision -> structured context -> answer
```

One broad question must no longer be represented by one retrieval query.

## 2. Scope and invariant - **FROZEN**

Phase 5E is broad/compositional RAG inside Project 1:

- deterministic query-scope classification;
- transparent facet discovery and decomposition;
- multiple retrieval queries over the existing indexed corpus;
- reuse of dense, lexical, union, reranking, and pruning;
- reuse of Phase 5D temporal applicability per facet;
- reuse of Phase 5C provenance and contradiction handling per relevant claim;
- explicit facet coverage and answer disposition;
- structured synthesis context and grounded generation;
- an inspectable synthesis plan and offline evaluation.

Phase 5E does not introduce:

- web browsing or external research;
- autonomous or open-ended agent loops;
- general tool planning;
- LLM-generated arbitrary subqueries in the first implementation;
- fine-tuning;
- Phase 6 ingestion, permissions, or authentication work;
- a new retrieval algorithm.

The existing focused QA path remains behaviorally unchanged. A focused question
must not pay the latency, context, or refusal cost of synthesis planning.

The phase invariant is:

> **Increasing breadth must not reduce epistemic discipline.**

More retrieved facets never create permission to guess. A broad answer must
still cite claims, preserve relevant conflicts and exceptions, respect temporal
applicability, disclose missing facets, distinguish current facts from
historical/proposed facts, and refuse unsupported requests.

High-scoring chunks are not evidence of broad support. Required facet coverage
must be evaluated explicitly before generation.

## 3. Facet and disposition contract - **FROZEN**

A facet is an inspectable evidence obligation, not a topic string and not proof
that a word appeared in a chunk.

The implementation may refine names, but it must preserve these semantics:

```ts
interface SynthesisFacet {
  id: string
  label: string
  query: string
  required: boolean
  critical: boolean
  subjectHints: string[]
  evidence: RetrievalResult[]
  requiredPropositions: string[]
  status:
    | 'covered'
    | 'partially-covered'
    | 'unsupported'
    | 'conflicted'
  dispositionReason: string
}

interface QueryScopeDecision {
  mode: 'focused' | 'synthesis'
  reason: string
}

type SynthesisDisposition =
  | 'answer'
  | 'partial-with-disclosure'
  | 'hold-for-conflict'
  | 'refuse-unsupported'
```

A facet is `covered` only when all of its required propositions have supporting
evidence, the evidence is applicable to the requested time and subject, and
required exceptions or negative evidence remain attached. A similarity score,
entity-name occurrence, or one proposition out of several is not coverage.

A facet is:

- `partially-covered` when some required propositions are supported but the
  complete requested dimension is not;
- `unsupported` when the requested proposition is absent from the corpus;
- `conflicted` when relevant evidence disagrees and the existing temporal and
  provenance layers cannot resolve it.

Disposition is frozen as follows:

| evidence state | disposition |
| --- | --- |
| every critical facet covered; all other required facets covered or explicitly non-critical | `answer` |
| a non-critical required facet is partial/unsupported and a truthful bounded answer remains useful | `partial-with-disclosure` |
| a critical facet has an unresolved relevant conflict | `hold-for-conflict` |
| the requested result depends on absent data, aggregation, or measurements | `refuse-unsupported` |

The coverage decision is local and inspectable. Generation cannot upgrade an
unsupported facet or override the disposition.

## 4. Proposed pipeline - **FROZEN**

```text
USER QUESTION
      |
QUERY SCOPE CLASSIFIER
      |
      +-- focused ----> existing focused pipeline, unchanged
      |
      `-- synthesis
             |
      FACET DISCOVERY / DECOMPOSITION
             |
      PER-FACET RETRIEVAL
      dense + lexical + union + rerank + prune
             |
      PER-FACET REASONING
      temporal applicability + provenance/contradiction
             |
      FACET COVERAGE + DISPOSITION
             |
      STRUCTURED SYNTHESIS CONTEXT
             |
      GROUNDED GENERATION OR LOCAL REFUSAL/HOLD
```

### 4.1 Query scope classification

The first classifier is deterministic and returns a reason. Initial positive
signals include `summarise`, `summarize`, `overview`, `current state of`,
`everything we know about`, `what are the main`, `explain the major`, and
multi-entity comparisons such as `compare A, B, C and D`.

Keyword presence alone is not a permanent design. It is the first transparent
boundary whose false positives and false negatives can be measured. Focused
controls in section 7 prevent broad mode from swallowing ordinary questions.

### 4.2 Facet discovery and decomposition

The first implementation must not ask an LLM to invent arbitrary subqueries.
It uses inspectable rules:

- an explicit comparison creates an entity-by-dimension facet matrix;
- an explicit list creates one facet per requested item;
- a broad state/history request uses a two-pass process: high-recall discovery,
  then normalized subjects/entities become candidate facets;
- recurrence increases candidate confidence but is not required for facet
  eligibility;
- a singleton subject may become a facet when generic structural cues identify
  it as a named policy, plan, benefit, exception, entitlement, limitation,
  deadline, deprecation, or explicit state change;
- generic policy dimensions such as price, eligibility, benefits, exceptions,
  effective dates, and inactive/proposed alternatives may refine discovered
  subjects when those dimensions are evidenced in the corpus.

Frequency is evidence of prominence, not importance. A repeated subject is a
strong candidate; a structurally salient singleton is also a candidate; an
incidental noun does not become a facet merely because it appears once. The
discovery trace must record which generic signal admitted each candidate so the
boundary remains inspectable.

**Singleton-salient-facet invariant - FROZEN.** A required facet that appears
sparsely must remain discoverable when the corpus structurally presents it as a
named policy, benefit, exception, entitlement, limitation, deadline,
deprecation, or state change. S1's forcing example is `continuity-credit`: M18
introduces the named Continuity Credit benefit and defines its scope, while the
rest of the corpus mentions it only sparsely. The discovery pass must still
produce the `continuity-credit` facet before per-facet retrieval and coverage.
The test may assert the generic structural discovery reason, but runtime code
may not seed that facet from the S1 answer key or from the word `Meridian`.

There must be no `if question includes Meridian` production branch. The frozen
Meridian facets are evaluation answer keys only; runtime decomposition must
derive facets through generic, inspectable rules.

### 4.3 Per-facet retrieval and reasoning

Every facet forms its own query and reuses the existing retrieval stack. Phase
5D then evaluates applicability at the requested `asOf` for that facet, and
Phase 5C handles relevant contradictions/provenance that remain. A conflict in
an unrelated facet must not block the full answer, preserving Phase 5D's
question-subject relevance invariant.

Coverage is evaluated after reasoning, not before it. A retrieved obsolete
price is evidence found but not current evidence covered.

### 4.4 Structured synthesis packet

The generation context is organized by facet rather than dumped in ranking
order:

```text
[FACET: Standard]
status: covered
applicable claims:
- Standard remained 55 credits in August 2026. [source/chunk]
- Standard included eight ferry crossings. [source/chunk]
excluded claims:
- 65 credits was a proposal, not an approved rate. [source/chunk]

[FACET: Dayline]
status: covered
applicable claims:
- 8 credits per active day; monthly cap 64. [source/chunk]
- Quiet Month did not apply. [source/chunk]
exception:
- 72 June users were held to the displayed 63-credit cap only. [source/chunk]
```

The packet records candidate chunks, used chunks, temporal outcome, conflicts,
missing propositions, and character/token budget per facet. Duplicate chunks
may be shared across facets without being counted as independent corroboration.

## 5. Frozen Meridian evidence anchors

The corpus is the single local source `meridian-access-programme.md`, built with
the stable document id `library-meridian-access-programme`. It currently has 29
chunks. Because one-document source recall would be trivial, Phase 5E measures
passage and proposition recall.

The benchmark refers to semantic anchors below. Current chunk ids are frozen as
an audit aid, but a chunker change must be reviewed against the semantic anchor
rather than silently rewriting the answer key.

| anchor | current chunk | required evidence signature |
| --- | --- | --- |
| M02 | `chunk-2` | 2024 launch: Standard 40, four ferries, resident/non-resident-worker eligibility |
| M03 | `chunk-3` | Standard/Supported/Institutional categories; Supported 22; Institutional blocks and 70% rebate rule |
| M04 | `chunk-4` | 2024 Quiet Month: fewer than three, 25% next month, Standard/Supported only |
| M05 | `chunk-5` | immediate-discount advice was wrong; audit did not end Quiet Month |
| M06 | `chunk-6` | Journey Guard above 18 per journey; not a monthly cap or discount |
| M07 | `chunk-7` | Bellweather University semester reassignment is customer-specific |
| M08 | `chunk-8` | January 2025 Standard 55 supersedes 40; Supported 22; ferries rise to six |
| M09 | `chunk-9` | 41.25 discounted Standard price; 30 is historically correct but obsolete |
| M10 | `chunk-10` | Flex pilot: 9 per active day, cap 63, no Quiet Month, Journey Guard applies |
| M12 | `chunk-12` | mobility Supported unlimited ferries and accompanying assistant exception |
| M13 | `chunk-13` | proposed/training-slide Journey Guard 25 never approved; 18 remained operative |
| M14 | `chunk-14` | October 2025 eight-ferry trial; mobility Supported remains unlimited |
| M15 | `chunk-15` | eight ferries permanent from January 2026; Standard remains 55 |
| M16 | `chunk-16` | proposed 65 Standard rate rejected by final 55 notice |
| M17 | `chunk-17` | March 2026 Quiet Month changes to fewer than four; still 25% next month |
| M18 | `chunk-18` | Continuity Credit: Standard, 12 months, one-time 12, supplemental charges only |
| M19 | `chunk-19` | May 2026 Institutional minimum falls to 20; rebate threshold 70%; no Quiet Month; university exception retained |
| M20 | `chunk-20` | Flex ends; Dayline 8 per active day, cap 64, residents, no Quiet Month, Journey Guard applies |
| M21 | `chunk-21` | 72 June users honored at displayed 63; official future Dayline cap remains 64 |
| M22 | `chunk-22` | eight ferries is not universal: mobility Supported unlimited; Dayline has no monthly allowance |
| M23 | `chunk-23` | Meridian North is an unlaunched expansion, not a membership category |
| M24 | `chunk-24` | explicit August 2026 state: Standard 55/eight, Journey Guard 18, Quiet Month fewer than four |
| M27 | `chunk-27` | current Supported example: 22, unlimited mobility ferries, assistant constraint, Quiet Month eligible |
| M28 | `chunk-28` | September 2026 adaptive membership is future, discussion-only, and unapproved |

An expected anchor is satisfied only by evidence containing the required
proposition. Retrieving the same chunk for a different sentence does not satisfy
the anchor.

## 6. Frozen broad/compositional evaluation cases

All cases use the local Meridian corpus and `asOf = 2026-08-31T23:59:59Z`
unless the question names a historical period. Expected facets are evaluation
keys, never runtime inputs.

### S1 - current-state synthesis

**Question:** Summarise Meridian as it existed in August 2026. Exclude obsolete,
proposed, pilot-only, or future rules.

| required facet | expected evidence | expected temporal outcome |
| --- | --- | --- |
| `standard-plan` | M15, M24 | current: 55 credits and eight included ferries |
| `supported-plan` | M12, M22, M27 | current: 22; ordinary allowance eight; mobility allowance unlimited; assistant constraint preserved |
| `institutional-plan` | M03, M19, M22 | current structure: employer/university blocks, minimum 20, 70% rebate threshold, no Quiet Month, allocated users generally eight ferries |
| `dayline` | M20, M22 | current: 8 per active day, cap 64, resident availability, no Quiet Month or monthly ferry allowance, Journey Guard applies |
| `quiet-month` | M17, M19, M20, M24, M27 | current: fewer than four, 25% next month; Standard/Supported eligible; Institutional/Dayline excluded |
| `journey-guard` | M06, M13, M24 | current: confirmation above 18 supplemental credits for one journey; 25 excluded |
| `ferry-policy` | M14, M15, M22, M24 | current: eight for most subscription members; mobility Supported and Dayline exceptions preserved |
| `continuity-credit` | M18 | current: qualifying Standard subscriber receives one-time 12 balance for supplemental charges only |
| `important-exceptions` | M07, M12, M21, M22 | university reassignment, accessibility/assistant, honored Dayline display cap, and non-universal ferry treatment preserved |
| `inactive-or-proposed` | M10, M13, M16, M20, M23, M28 | Flex ended; 25 and 65 unapproved; North unlaunched; September adaptive draft future and unapproved |

Every facet is required and critical. Expected disposition: `answer`. Any
missing facet prevents an unqualified complete summary; an implementation may
emit `partial-with-disclosure`, but that does not pass S1.

### S2 - multi-entity comparison

**Question:** Compare Standard, Supported, Institutional and Dayline as of
August 2026.

The facet shape is a matrix, not four unrelated summaries:

| entity | pricing model | users/purchaser | ferry treatment | Quiet Month | important exceptions |
| --- | --- | --- | --- | --- | --- |
| Standard | 55 monthly (M15/M24) | ordinary subscription; launch eligibility evidence in M02 | eight (M24) | eligible under current threshold (M17/M24) | Continuity Credit is Standard-only (M18) |
| Supported | 22 monthly (M12/M27) | qualifying students, pensioners, benefit recipients; mobility subset (M03/M12) | ordinary eight; mobility unlimited (M22/M27) | eligible (M27) | assistant only while accompanying (M12/M27) |
| Institutional | block purchase; nominal price historically described as Standard-equivalent (M03/M19) | employers/universities; minimum block 20 (M19) | allocated users generally eight (M22) | ineligible (M19) | 70% rebate threshold; Bellweather University reassignment only (M07/M19) |
| Dayline | 8 per active day, cap 64 (M20) | any Bellweather resident (M20) | no equivalent monthly included allowance (M22) | ineligible (M20) | 72 June users honored at displayed cap 63 only (M21) |

Expected temporal outcome: compare the August 2026 state; do not substitute
Flex, launch-era Standard pricing, six-ferry allowances, or the 65 proposal.
Expected disposition: `answer`.

The Institutional numeric-rate cell is intentionally conservative: the corpus
states the Standard-equivalent nominal-price relationship in the early category
description but does not explicitly restate a numeric Institutional rate in the
May 2026 revision. The benchmark requires the pricing *model* and provenance of
that relationship, not an invented numeric August rate.

### S3 - chronological policy-change synthesis

**Question:** Explain the major Meridian policy changes from 2024 through
August 2026.

Required chronological facets:

| period | expected evidence | expected temporal outcome |
| --- | --- | --- |
| January-June 2024 | M02, M03, M04, M06 | launch Standard 40/four ferries; categories; Quiet Month fewer than three; Journey Guard 18 introduced |
| September 2024 | M07 | Bellweather University customer-specific reassignment exception |
| January-February 2025 | M08, M10 | Standard 55 supersedes 40; ferries six; Flex pilot begins |
| April 2025 | M12 | mobility Supported unlimited ferries and assistant rule begins |
| summer-December 2025 | M13, M14, M15, M16 | 25 Journey Guard rejected; ferry allowance trials eight then becomes permanent; 65 Standard rejected and 55 retained |
| March-May 2026 | M17, M18, M19 | Quiet Month threshold changes; Continuity Credit begins; Institutional minimum becomes 20 while rebate/no-Quiet rules persist |
| June-August 2026 | M20, M21, M22, M23, M24 | Flex ends; Dayline begins; display-cap exception; ferry wording corrected; North remains unlaunched; August state confirmed |

Expected temporal outcome: preserve historical states in their valid periods and
distinguish actual changes from proposals, errors, and customer-specific
exceptions. M28 is outside the requested range and may appear only as an
explicit exclusion, never as an August rule. Expected disposition: `answer`.

`Major` is otherwise subjective, so the rows above are the frozen required set.
Other correctly grounded details are allowed but cannot compensate for a
missing required row.

### S4 - exception and minority-rule synthesis

**Question:** What important exceptions could make a general description of
Meridian misleading?

Required facets:

| facet | expected evidence | expected temporal outcome |
| --- | --- | --- |
| `mobility-supported-ferries` | M12, M22, M27 | unlimited, not eight |
| `assistant-travel` | M12, M27 | free only while accompanying; no independent membership/solo privilege |
| `bellweather-university` | M07, M19 | semester reassignment applies only to that customer |
| `dayline-benefit-exclusions` | M20, M22 | no Quiet Month and no subscription-style monthly ferry allowance |
| `dayline-display-error` | M21 | 72 affected users honored at 63; official cap remains 64 |
| `quiet-month-audit` | M05 | mistaken immediate adjustments were not reclaimed; audit did not end the benefit |

Expected temporal outcome: preserve each exception's scope; never generalize it
to all members. Expected disposition: `answer`.

`Important` is subjective in natural language. The six rows above freeze the
benchmark meaning. Additional grounded exceptions are acceptable but do not
replace a required one.

### S5 - proposed, rejected, mistaken, or obsolete rules

**Question:** Which Meridian rules were proposed, mistaken, or discussed but
were not current policy by August 2026?

Required negative-evidence facets:

| rejected/misleading claim | expected evidence | expected outcome |
| --- | --- | --- |
| Quiet Month discount is immediate or the audit ended it | M05 | false; next-month benefit remained in force |
| Journey Guard is an 18-credit monthly cap | M06 | false; it is a per-journey confirmation threshold |
| current discounted Standard price is 30 | M09 | obsolete 2024 calculation; current discounted amount is 41.25 |
| Flex is the current usage-priced product | M10, M20 | obsolete pilot; ended June 2026 and replaced by Dayline option |
| Journey Guard threshold is 25 | M13 | proposal/training error; never approved |
| Standard price is 65 in 2026 | M15, M16 | budget proposal; final rate remained 55 |
| official Dayline cap is 63 | M20, M21 | display error honored for 72 users only; official cap 64 |
| every member receives eight ferries | M22 | overgeneralization; mobility Supported and Dayline differ |
| Meridian North is a current membership | M23 | false; unlaunched geographic proposal |
| adaptive membership/28-credit base replaced current plans | M28 | after the target date, discussion-only, unapproved |

Expected temporal outcome: all listed claims are excluded from August 2026
current policy while their historical/proposal/exception status is retained.
Expected disposition: `answer`.

### S6 - intentionally unsupported broad request

**Question:** Give the exact number of Meridian members using every membership
type in August 2026 and their average monthly expenditure.

Expected active-type discovery uses M19, M20, M22, and M24: Standard,
Supported, Institutional, and Dayline are relevant current categories/products.
For each, both requested metric facets are `unsupported`:

```text
Standard       August member count unsupported; average spend unsupported
Supported      August member count unsupported; average spend unsupported
Institutional  August member count unsupported; average spend unsupported
Dayline        August member count unsupported; average spend unsupported
```

M05's 417 audited accounts, M07's 3,200 university memberships, M10's 600 Flex
pilot members, and M21's 72 display-error users are tempting but answer different
questions, periods, or populations. They must not be substituted, summed, or
used to estimate the requested metrics.

Expected temporal outcome: current membership types may be identified, but the
requested August counts and expenditure averages remain absent. Expected
disposition: `refuse-unsupported`, with the missing fields named. Retrieving a
large amount of related evidence must not change that disposition.

## 7. Focused-path regression controls - **FROZEN**

These are not synthesis cases. They ensure scope classification preserves the
existing path:

| id | question | expected mode | expected focused outcome |
| --- | --- | --- | --- |
| F1 | What was the Standard price in August 2026? | `focused` | 55, not 40 or 65 |
| F2 | What did Standard cost in 2024? | `focused` | 40 |
| F3 | Did the proposed 25-credit Journey Guard threshold take effect? | `focused` | no; 18 remained operative |
| F4 | Does Dayline qualify for Quiet Month? | `focused` | no |
| F5 | What is the exact average monthly expenditure of a Supported member in August 2026? | `focused` | refuse as unsupported |

The classifier may use synthesis for a genuinely multi-entity comparison even
without a summary keyword. It must record the deterministic reason.

## 8. Inspector and offline measurement contract - **FROZEN**

The synthesis inspector must expose at least:

```text
mode and classification reason
requested asOf
discovery candidates and why each became/did not become a facet
facet id, query, required/critical flags
candidate sources/chunks and selected evidence
temporal applicability and excluded claims
conflict/provenance outcome
facet status and missing propositions
overall disposition and reason
final context: facets, unique chunks, characters/tokens
provider called: yes/no
```

Offline evaluation runs before generation and records:

```text
Facet Recall
  required facets discovered / required facets

Facet Evidence Recall
  required facets whose required evidence propositions were found / required facets

Singleton Salient Recall
  required singleton-salient facets discovered / required singleton-salient facets

Currentness Accuracy
  applicable/excluded propositions classified correctly / temporal propositions

Exception Preservation
  required scoped exceptions retained / required scoped exceptions

Unsupported-facet Detection
  absent requested metric facets marked unsupported / absent requested metric facets

Disposition Accuracy
  cases with expected answer/partial/hold/refuse disposition / cases
```

Minimum gate before any live generation validation:

- S1-S5: 100% required facet discovery and required evidence recall;
- S1: `continuity-credit` discovered from generic singleton-salience signals,
  before per-facet retrieval, with no benchmark seed or Meridian-specific rule;
- all required singleton-salient fixtures: 100% Singleton Salient Recall;
- all cases: 100% expected temporal/currentness outcomes;
- S4: 100% required exception preservation;
- S6: all eight count/expenditure cells marked unsupported and no unrelated
  number substituted;
- S1-S6: exact expected synthesis mode/disposition;
- F1-F5: exact expected focused mode/outcome;
- zero provider calls.

These are benchmark gates, not claims of general-domain completeness.

## 9. Small live validation contract - **FROZEN, NOT AUTHORIZED**

Live generation is outside Step 1 and requires separate authorization after the
offline gate passes. The eventual smallest useful set is:

- S1 current-state synthesis;
- S2 comparison;
- S5 negative/proposed-policy synthesis;
- S6 unsupported aggregate refusal.

The live report must compare generated claims against the already-recorded
facet packet. It must not use generation success to excuse a failed offline
facet or currentness check.

## 10. Known ambiguities and benchmark-design limitations

These are explicit constraints, not implementation permission to improvise:

1. **Single-document corpus.** Meridian is one synthetic essay split into 29
   chunks. It can test passage/proposition coverage, decomposition, temporal
   filtering, and context construction, but not cross-document authority or
   source diversity. Passing 5E must not be described as general multi-source
   synthesis until a later, separately frozen corpus tests that property.

2. **The reported no-answer result is external to the checked-in artifact.**
   `test:meridian` demonstrates missing topic coverage but does not call a
   generator or record the prior no-answer response. Step 1 treats the report as
   motivation and the local coverage result as the reproducible baseline.

3. **Natural-language completeness is subjective.** Words such as `major`,
   `important`, and `summarise` have no universal stopping rule. Cases S1, S3,
   S4, and S5 freeze finite required sets so evaluation cannot move after
   implementation. Passing those sets proves benchmark coverage, not that every
   possible reader would choose the same outline.

4. **Institutional current price is not explicitly restated numerically in
   2026.** The corpus says the nominal price was Standard-equivalent and later
   revises block size/rebate rules, but does not state `Institutional = 55` in an
   August sentence. S2 therefore requires the evidenced pricing model and its
   provenance, not an inferred current number.

5. **Current eligibility is not uniformly restated.** M02 describes Standard
   tourist/non-resident eligibility at launch, and M03 describes the initial
   Supported groups. S2 may identify these as launch/category evidence, but it
   must not silently present an unchanged August 2026 eligibility rule where
   the corpus does not explicitly establish continuity.

6. **Post-`asOf` evidence can be relevant negative evidence.** M28 is dated
   September 2026. It may be retrieved to prove that the adaptive plan is future
   and unapproved, but it cannot become an August rule. Retrieval after the
   target date is allowed; applicability after the target date is not.

7. **Answer-key leakage would invalidate the experiment.** Expected facets and
   anchors live in evaluation fixtures/documents only. Runtime code may not
   import them, branch on `Meridian`, or seed discovered facets from S1-S6.

8. **Chunk ids are implementation-coupled.** Semantic evidence signatures are
   authoritative. A changed chunker may legitimately move a proposition, but
   the benchmark update requires review and a recorded migration rather than an
   automatic id refresh.

9. **Facet overlap is real.** M22 supports Supported, Dayline, ferry, and
   exception facets. Sharing evidence is allowed, but one retrieved topic word
   cannot mark several facets covered; each facet's required proposition must be
   checked independently.

## 11. Planned sequence after contract review

| step | work | provider access |
| --- | --- | --- |
| 1 | Freeze benchmark and architecture in this document | none - this step only |
| 2 | Review contract and close requested benchmark changes | none |
| 3 | Encode S1-S6, F1-F5, anchors, and expected propositions as fixtures | none |
| 4 | Deterministic scope classifier | none |
| 5 | Transparent comparison and two-pass broad facet discovery | none |
| 6 | Per-facet reuse of existing retrieval | none |
| 7 | Per-facet temporal/provenance reasoning adapter | none |
| 8 | Coverage/disposition engine and structured packet | none |
| 9 | Inspector | none |
| 10 | Offline evaluation and report | none |
| 11 | Small live validation | separate authorization required |
| 12 | Final report, reviewed commit, and push | none |

Stop after Step 1. Do not implement, call a provider, or commit until this
contract has been reviewed.
