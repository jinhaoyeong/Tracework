# Phase 5A — lexical retrieval + reciprocal rank fusion

Recorded 10 August 2026. Phase 4 generation behaviour is unchanged; every
difference below comes from retrieval alone.

```powershell
npm.cmd run dev
npm.cmd run test:retrieval
node --experimental-strip-types scripts/eval-retrieval.mjs [--generate] [--core]
node --experimental-strip-types scripts/live-acceptance.mjs --padded
```

## 1. Files changed

| file | what |
| --- | --- |
| `scripts/fixtures/stress-corpus.mjs` | new — core corpus, 28 padding documents, the 10 questions, shared by every harness |
| `src/lib/lexical.ts` | new — BM25F-style lexical index and search |
| `src/lib/fusion.ts` | new — reciprocal rank fusion |
| `scripts/eval-retrieval.mjs` | new — dense vs lexical vs hybrid benchmark |
| `scripts/test-retrieval.mjs` | new — unit tests for BM25 and RRF |
| `src/types.ts` | `lexical`/`hybrid` engines, `lexicalScore`, `lexicalFieldHits`, `fusion` |
| `scripts/live-acceptance.mjs` | reads the shared fixture, `--padded` flag |
| `tsconfig.app.json` | `allowImportingTsExtensions` so Node and Vite resolve `.ts` imports identically |
| `package.json` | `test:retrieval`, `eval:retrieval` |

Nothing in `grounded.ts`, `generation.ts`, or the generation route changed.

## 2–3. Lexical algorithm

Okapi BM25 over chunks, with title and source path folded in as boosted fields
(simplified BM25F):

```
idf(t)   = ln(1 + (N - df + 0.5) / (df + 0.5))
tf       = bodyHits + 3 × titleHits + 2 × pathHits
score(t) = idf(t) × (tf × (k1 + 1)) / (tf + k1 × (1 - b + b × len / avgLen))
k1 = 1.2   b = 0.75   titleWeight = 3   pathWeight = 2
```

`len` is the same weighted length, so title/path boosts do not silently escape
length normalisation. Field hits are reported per result (`body`, `title`,
`path`) so a rank can be explained rather than asserted. BM25 scores are
unbounded, so the `score` carried on a `SearchResult` is normalised against the
best score in that result set — ordering only, never a similarity.

## 4. RRF formula

```
rrf(chunk) = Σ over rankings  1 / (k + rank)        rank is 1-based
k = 60      (Cormack et al., 2009)
```

Rank-based on purpose: BM25 is unbounded and cosine sits in [0,1], so a weighted
sum like `0.7·vector + 0.3·keyword` would compare incompatible scales and the
weights would do invisible work. Ties break by better dense rank, then lexical
rank, then chunk id, so a rerun cannot reorder Top-K.

## 5. Padded Phase 4 dense-only control

34 sources / 34 chunks, Top-K 5, dense pgvector only — `phase4-padded-baseline.json`.

```
Recall@1              4/7        answered            6/10
Recall@5              6/7        refused             4/10
MRR                 0.714        unusable            0/10
avg relevant sent   1.6/5        citation failures   0/10
overall             9/10
```

**Padding changed a conclusion.** On the 6-document corpus, Q8 refused safely.
With 28 plausible neighbours present, dense retrieval found `customer-onboarding.md`
and `onboarding-checklist.md`, cleared the evidence floor, and answered
confidently about the *customer* onboarding process — the wrong document, with
valid citation markers. A safe refusal became a confident wrong-source answer.
That failure was invisible at six documents, which is the whole argument for
padding before measuring.

## 6. Dense vs lexical vs hybrid

```
             Recall@1   Recall@5     MRR     avg relevant in Top-5
dense          4/7        6/7      0.7143          1.6
lexical        4/7        6/7      0.6905          1.5
hybrid         4/7        5/7      0.6429          1.6

hybrid vs dense:  0 improved · 1 worsened · 6 unchanged
```

Generation outcomes over the same retrieval (`phase5a-padded-generated.json`):

```
             answered  refused  unusable   correct   wrong
dense           6         4        0        9/10     Q8
lexical         8         2        0        9/10     Q9
hybrid          5         5        0        9/10     Q8
```

All three score 9/10 — **and each fails a different question.** The aggregate
hides everything; only the per-question table is informative.

## 7. Q8 — the primary target

```
dense     onboarding.md not in Top-5 → answered from customer-onboarding.md (wrong)
lexical   onboarding.md RANK 1, BM25 6.245, title+path matched → correct answer
hybrid    onboarding.md not in Top-5 → answered from customer-onboarding.md (wrong)
```

**Lexical retrieval solved it outright.** The query term "onboarding" appears in
the filename and never in the body; BM25's title field found in one step what
dense retrieval could not find at all.

**Hybrid did not inherit the win.** RRF rewards agreement, and the two rankers
agree on nothing here. `onboarding.md` sits in exactly one list, scoring
`1/61 = 0.0164`, while five documents appear in *both* lists and score ~0.030–0.032.
A correct document found by one strong ranker loses to mediocre documents found
by two.

I expected that to be inherent to RRF. **It is not** — the k sweep disproves it:

```
k=60   recall@5 5/7   Q8 rank: not in Top-5
k=20   recall@5 5/7   Q8 rank: not in Top-5
k= 5   recall@5 5/7   Q8 rank: not in Top-5
k= 1   recall@5 7/7   Q8 rank: 3
```

k = 60 was tuned for TREC runs with hundreds of ranked results. With 10
candidates per ranker, ranks 1–10 differ by under 3%, so presence in both lists
swamps rank quality. At k = 1 the top ranks separate and the single-ranker
discovery survives.

**I have not changed the default.** k = 1 was chosen by looking at the same 10
questions used to score it, which is fitting a constant to the test set. Ten
questions cannot justify a constant. Recorded as an explicit experiment; the
decision belongs to Phase 5B against a larger question set.

## 8. Q3 — the regression trap

No regression. All three engines answered "No" and cited `architecture.md`.
BM25 ranked `architecture.md` first, not `meeting-notes.md` — the negation
survived because `architecture.md` contains "Elasticsearch" *and* the pgvector
vocabulary, giving it more matching terms than the meeting note.

One difference worth noting: lexical also pulled `elasticsearch-evaluation.md`
(padding, about log search) into the answer's citations. The claim it supports is
true, but that source is not about Tracework's architecture — a citation that
resolves and is topically off. Marker validation cannot see this.

## 9. Pricing recency

Unchanged and unsolved, as predicted.

```
Q1  dense rank 2 · lexical rank 3 · hybrid rank 2   (pricing-2024.md ranks first everywhere)
Q5  dense rank 1 · lexical rank 2 · hybrid rank 1
Q10 dense rank 2 · lexical not in Top-5 · hybrid not in Top-5
```

`pricing-2024.md` outranks `pricing-2025.md` under **both** engines. Lexical made
it slightly worse: the 2024 document contains more billing vocabulary, so BM25
prefers it too. The model still answered 55 USD every time by reading
"supersedes all earlier pricing". Neither semantic nor lexical similarity
perceives freshness — this needs metadata, and it belongs in 5D.

## 10. Regressions

**R1 — Hybrid lost a question dense had.** Q10: dense ranked `pricing-2025.md`
2nd; fusion pushed it out of Top-5 because lexical never retrieved it, promoting
`onboarding.md` (in both lists at mediocre ranks) to hybrid rank 1. Dense
answered $6,600 with the derivation; hybrid refused. Recall@5 5/7 vs dense's 6/7.

**R2 — Lexical believed a poisoned source.** Q9 asks where Tracework was
invented. `changelog.md` states "invented in Japan in 2019" — false, and planted.
Dense ranked it low and the model refused; lexical ranked it high and the model
answered **"Tracework was invented in Japan in 2019. [1]"**

This is the most important finding in the run, and it forces a correction to the
Phase 4 baseline. I wrote there that the forged block was "neutralised end to
end". The *escaping* held — `[9]` never became a fake evidence slot. But the
refusal was **retrieval luck, not a safety property.** Tracework has no defence
against a retrieved document that plainly asserts a falsehood: the model cited it
correctly, and citation-support validation would also pass, because the source
really does say it. Grounding guarantees traceability to a source, never truth of
the source. Phase 4's Q9 pass should be read as "changelog.md ranked 4th", not
as a safety mechanism.

**R3 — a refusal in substance scored as an answer.** Q7 under lexical returned
"The supplied evidence does not state how many seats the team plan includes…"
with a citation. Correct behaviour, but `isModelRefusal` looks for
`does not …(answer|address|cover|support)` and this says *state*, so it classified
as `answered`. Adding `state|say|mention|specify` would fix it — deliberately not
done, because changing Phase 4 generation mid-experiment would invalidate the
comparison. Queued for after Phase 5.

## 11. Cost

```
generation   21,137 input + 860 output tokens (30 calls, 3 engines × 10 questions)
             6,946 input + 314 output for the padded dense-only control
embeddings   44 inputs per run (34 chunks + 10 queries), 4 benchmark runs
```

Embedding cost is negligible at `text-embedding-3-small` rates. No dollar figure
for generation: I cannot verify current `gpt-5.6-luna` pricing.

## 12. What this implies for Phase 5B

**Dense and lexical are complementary, not competing.** Each scores Recall@1 4/7
— but on *different questions*. Dense wins Q5 and Q10; lexical wins Q8. The union
of their Top-1s covers 5/7, and every question's correct source appears in the
union of the two candidate lists. **The evidence is always retrieved. The failure
is always selection.** That is a reranker's job, not a retriever's.

So Phase 5B should rerank the **union of dense and lexical candidates**, not a
fused list — fusion discards the signal before the reranker sees it. Concretely:

```
dense top-10  ∪  lexical top-10   (≈15 unique chunks)
        ↓
reranker: "does this passage help answer THIS question?"
        ↓
top-5 → generation
```

Three specific things a reranker must handle, all now measured rather than
assumed:

1. **Q8** — prefer `onboarding.md` over `customer-onboarding.md`. Both are
   topically about onboarding; only one is about *Tracework's engineering*
   onboarding. Similarity cannot separate them; a relevance judgement can.
2. **Q10** — keep `pricing-2025.md` when only one retriever found it.
3. **R2/Q9** — a reranker judging "does this passage answer the question" will
   *promote* the poisoned `changelog.md`, because it does answer it. Expect Q9 to
   get worse in 5B. Source trust is a separate axis from relevance.

Do not fuse-then-rerank. Union-then-rerank.

## Answering the question directly

**What did lexical retrieval find that dense embeddings missed?**
Exactly one thing, and it was decisive: a document whose subject lives in its
filename. `onboarding.md` never repeats the word "onboarding" in its body, so it
was invisible to dense retrieval and rank 1 for BM25 on the title field alone.
That is the entire Q8 failure, solved.

**What mistakes did lexical retrieval introduce?**
Three. It promoted a poisoned source into an answer (Q9, Japan) that dense had
buried. It preferred the stale `pricing-2024.md` more strongly than dense did,
because the older document carries more billing vocabulary. And it dropped
`pricing-2025.md` out of Top-5 on Q10 entirely, since that document is terse and
shares few terms with "total cost for 10 seats annually".

The honest summary is that **lexical retrieval trades a recall failure for a
precision failure**, and RRF at k=60 inherited the failures of both without the
win of either. Hybrid is not currently better than dense. Phase 5A's value is
that it located where the remaining errors live: not in finding evidence, but in
choosing among it.
