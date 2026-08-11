/**
 * Pure reporting semantics for the Phase 5D Step 10 live run.
 *
 * T7 is a mechanism test offline, but a provider-backed system test live. The
 * live ranker may either prune the superseder (coverage rescue) or retain it
 * naturally (coverage not needed). Both paths are valid when the final
 * temporal answer is 55 and the generated answer remains cited.
 */
const T7_SUPERSEDER = 't-pricing-2025.md'

const unique = (values) => [...new Set(values)]
const includesValue = (value, expected) => typeof value === 'string' && value.includes(expected)
const sameList = (left, right) => left.length === right.length && left.every((value, index) => value === right[index])
const check = (name, passed, detail) => ({ name, passed, detail })

const titlesFrom = (record, property, fallback = []) => {
  const values = record.retrieval?.[property]
  return Array.isArray(values) ? values : fallback
}

/**
 * Classify the observed live T7 path without changing any retrieval or
 * temporal result. This function is intentionally pure so it can be applied
 * to a saved provider run with zero additional provider calls.
 */
export const classifyT7LiveOutcome = (record, { offlineCoverageRescueProven = null } = {}) => {
  const prePruning = titlesFrom(record, 'beforePruning')
  const normalContext = titlesFrom(record, 'afterPruning', record.t7?.beforeCoverage?.context ?? [])
  const coveredContext = titlesFrom(record, 'afterTemporalCoverage', record.t7?.afterCoverage?.context ?? [])
  const derivedCoverageAdded = unique(coveredContext.filter((title) => !normalContext.includes(title)))
  const coverageAdded = Array.isArray(record.retrieval?.restoredByTemporalCoverage)
    ? unique(record.retrieval.restoredByTemporalCoverage)
    : derivedCoverageAdded
  const witnessRetrieved = prePruning.includes(T7_SUPERSEDER)
  const witnessSurvived = normalContext.includes(T7_SUPERSEDER)
  const witnessPresentAfterCoverage = coveredContext.includes(T7_SUPERSEDER)
  const noCoverageValue = record.temporal?.withoutCoverage?.resolvedValue
    ?? record.t7?.beforeCoverage?.survivingValue
    ?? null
  const resolvedValue = record.temporal?.resolution?.resolvedValue
    ?? record.t7?.temporalResolution?.value
    ?? null
  const coverageNoOp = sameList(normalContext, coveredContext) && coverageAdded.length === 0
  const coverageMode = witnessSurvived
    ? 'not-needed'
    : witnessPresentAfterCoverage
      ? 'rescued'
      : 'rescue-failed'
  const coverageRescueObserved = coverageMode === 'rescued'

  const checks = [
    check(
      'T7 superseder retrieved before pruning',
      witnessRetrieved,
      witnessRetrieved
        ? `${T7_SUPERSEDER} was present in the pre-pruning ranked pool.`
        : `${T7_SUPERSEDER} was absent from the pre-pruning ranked pool: ${prePruning.join(', ')}`,
    ),
  ]

  if (coverageMode === 'rescued') {
    checks.push(
      check(
        'T7 coverage rescue observed',
        coverageAdded.includes(T7_SUPERSEDER),
        coverageAdded.includes(T7_SUPERSEDER)
          ? `${T7_SUPERSEDER} was pruned and restored by temporal coverage.`
          : `coverage did not add ${T7_SUPERSEDER}; added ${coverageAdded.join(', ') || 'nothing'}`,
      ),
      check(
        'T7 no-coverage arm is stale 40',
        includesValue(noCoverageValue, '40'),
        `expected no-coverage resolution to contain 40, got ${JSON.stringify(noCoverageValue)}`,
      ),
      check(
        'T7 coverage changes resolution',
        includesValue(noCoverageValue, '40') && includesValue(resolvedValue, '55') && noCoverageValue !== resolvedValue,
        `expected 40 without coverage and 55 after coverage, got before=${JSON.stringify(noCoverageValue)} after=${JSON.stringify(resolvedValue)}`,
      ),
    )
  } else if (coverageMode === 'not-needed') {
    checks.push(
      check(
        'T7 witness survived normal pruning',
        witnessSurvived,
        `${T7_SUPERSEDER} was ${witnessSurvived ? '' : 'not '}present in normal context: ${normalContext.join(', ')}`,
      ),
      check(
        'T7 coverage not needed live',
        coverageNoOp,
        coverageNoOp
          ? 'the superseder survived and temporal coverage added nothing.'
          : `coverage changed the normal context: before=${normalContext.join(', ')} after=${coveredContext.join(', ')} added=${coverageAdded.join(', ') || 'nothing'}`,
      ),
      check(
        'T7 already-covered resolution is 55',
        includesValue(noCoverageValue, '55') && includesValue(resolvedValue, '55'),
        `expected 55 with and without coverage, got before=${JSON.stringify(noCoverageValue)} after=${JSON.stringify(resolvedValue)}`,
      ),
    )
  } else {
    checks.push(
      check(
        'T7 coverage path completed',
        false,
        `${T7_SUPERSEDER} was pruned but was not present after temporal coverage.`,
      ),
    )
  }

  checks.push(
    check(
      'T7 final temporal resolution is 55',
      includesValue(resolvedValue, '55'),
      `expected final temporal resolution to contain 55, got ${JSON.stringify(resolvedValue)}`,
    ),
  )

  return {
    coverageMode,
    coverageRescueObserved,
    coverageAdded,
    offlineCoverageRescueProven,
    beforeCoverage: {
      survivingValue: noCoverageValue,
      resolutionStatus: record.temporal?.withoutCoverage?.status ?? record.t7?.beforeCoverage?.resolutionStatus ?? null,
      context: normalContext,
    },
    supersedingWitness: {
      source: T7_SUPERSEDER,
      retrievedPrePruning: witnessRetrieved,
      prunedFromNormalContext: witnessRetrieved && !witnessSurvived,
      survivedNormalPruning: witnessSurvived,
      rerankedRank: record.retrieval?.reranked?.find((candidate) => candidate.source === T7_SUPERSEDER)?.rank
        ?? record.t7?.supersedingWitness?.rerankedRank
        ?? null,
    },
    afterCoverage: {
      witnessPresent: witnessPresentAfterCoverage,
      witnessRestored: coverageRescueObserved,
      context: coveredContext,
      coverageAdded,
    },
    checks,
  }
}

export const classifyRecordedPhase5dLive = (input, { offlineCoverageRescueProven = null } = {}) => {
  const records = input.records.map((record) => {
    if (record.id !== 'T7') return record

    const classification = classifyT7LiveOutcome(record, { offlineCoverageRescueProven })
    const checks = [
      ...(record.checks ?? []).filter((entry) => !entry.name.startsWith('T7 ')),
      ...classification.checks,
    ]
    const passed = checks.every((entry) => entry.passed)
    const failureCategories = unique([
      ...(record.failureCategories ?? []).filter((category) => category !== 'coverage failure'),
      classification.checks.some((entry) => !entry.passed) ? 'coverage failure' : null,
    ].filter(Boolean))

    return {
      ...record,
      checks,
      passed,
      failureCategories,
      t7: {
        ...record.t7,
        ...classification,
        finalOutcome: passed ? 'PASS' : 'FAIL',
        temporalResolution: {
          status: record.temporal?.resolution?.status ?? null,
          value: record.temporal?.resolution?.resolvedValue ?? null,
          citations: record.temporal?.resolution?.resolvedClaims?.map((claim) => claim.source) ?? [],
        },
        finalGeneratedAnswer: record.finalAnswer,
      },
    }
  })

  return {
    ...input,
    records,
    passed: records.length > 0 && records.every((record) => record.passed),
  }
}
