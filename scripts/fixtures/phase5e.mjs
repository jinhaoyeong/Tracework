/**
 * Phase 5E frozen fixtures - compositional and broad synthesis.
 *
 * Evaluation-only answer-key data. Production modules must never import this
 * file, its expected facets, evidence anchors, propositions, or dispositions.
 * These fixtures encode docs/phase5e-plan.md before synthesis behavior exists.
 */

export const PHASE5E_REFERENCE_AS_OF = '2026-08-31T23:59:59Z'

export const MERIDIAN_BENCHMARK_SOURCE = Object.freeze({
  collectionSlug: 'meridian-access-programme',
  documentId: 'library-meridian-access-programme',
  title: 'meridian-access-programme.md',
  expectedChunkCount: 29,
})

const signature = (id, proposition, allOf) => Object.freeze({ id, proposition, allOf: Object.freeze(allOf) })

const anchor = (id, chunkNumber, semanticSignatures) => Object.freeze({
  id,
  sourceId: MERIDIAN_BENCHMARK_SOURCE.documentId,
  auditChunkId: `${MERIDIAN_BENCHMARK_SOURCE.documentId}-chunk-${chunkNumber}`,
  semanticSignatures: Object.freeze(semanticSignatures),
})

/**
 * Semantic signatures are authoritative. auditChunkId records the current
 * mapping, but validation locates evidence by proposition text first so a
 * reviewed chunker change does not silently redefine an anchor.
 */
export const MERIDIAN_EVIDENCE_ANCHORS = Object.freeze({
  M02: anchor('M02', 2, [
    signature('launch-standard-package', 'At launch Standard cost 40 credits and included four ferry crossings.', ['At launch', '40 credits per month', 'four ferry crossings']),
    signature('launch-eligibility', 'Launch eligibility excluded tourists but admitted qualifying non-resident workers.', ['not initially available to tourists', 'non-residents who could prove they worked inside Bellweather']),
  ]),
  M03: anchor('M03', 3, [
    signature('initial-categories', 'The initial categories were Standard, Supported, and Institutional.', ['three categories: Standard, Supported, and Institutional']),
    signature('supported-price', 'Supported members paid 22 credits per month.', ['Supported members', '22 credits per month']),
    signature('institutional-model', 'Institutional accounts used blocks and a 70 percent active-use rebate threshold.', ['blocks of at least fifty memberships', '70 percent']),
    signature('institutional-nominal-price', 'Institutional nominal price was described as identical to Standard.', ['nominal price of an Institutional membership was identical to the Standard price']),
  ]),
  M04: anchor('M04', 4, [
    signature('quiet-month-2024', 'Quiet Month initially required fewer than three journeys and discounted the following month by 25 percent.', ['fewer than three journeys', 'following month', 'reduced by 25 percent']),
    signature('quiet-month-initial-scope', 'Quiet Month applied to Standard and Supported but not Institutional.', ['applied to Standard and Supported memberships but not to Institutional memberships']),
  ]),
  M05: anchor('M05', 5, [
    signature('quiet-month-immediate-error', 'Advice that Quiet Month applied immediately was incorrect.', ['incorrectly told travellers that the reduction happened immediately']),
    signature('quiet-month-audit-continuity', 'The audit corrected timing but did not end Quiet Month.', ['audit is sometimes mistakenly described as ending the Quiet Month benefit', 'leaving the rule itself in force']),
  ]),
  M06: anchor('M06', 6, [
    signature('journey-guard-18', 'Journey Guard required confirmation above 18 supplemental credits for one journey.', ['more than 18 credits in supplemental charges', 'required confirmation']),
    signature('journey-guard-not-monthly-cap', 'Journey Guard was not a monthly cap or discount.', ['Journey Guard was not a discount', 'applied per journey']),
  ]),
  M07: anchor('M07', 7, [
    signature('bellweather-university-exception', 'Bellweather University alone could reassign unused Institutional memberships once per semester.', ['reassigned once each semester', 'applied only to Bellweather University']),
  ]),
  M08: anchor('M08', 8, [
    signature('standard-2025-price', 'January 2025 raised Standard from 40 to 55 and superseded earlier pricing.', ['increased from 40 to 55 credits per month', 'superseded all earlier Standard pricing']),
    signature('supported-remained-22', 'Supported remained 22 credits.', ['Supported membership remained 22 credits']),
    signature('ferries-rise-to-six', 'The included ferry allowance rose from four to six.', ['changed the included ferry allowance from four crossings per month to six']),
  ]),
  M09: anchor('M09', 9, [
    signature('quiet-month-41-25', 'At the 55-credit rate a Standard Quiet Month price was 41.25.', ['55-credit price', 'paid 41.25 credits']),
    signature('quiet-month-30-obsolete', 'The 30-credit calculation was historical rather than current.', ['30 credits', 'historically correct', 'no longer represented the current Standard rate']),
  ]),
  M10: anchor('M10', 10, [
    signature('flex-pilot-pricing', 'Flex was a 600-person pilot at 9 credits per active day capped at 63.', ['pilot called Meridian Flex', '600 randomly selected Standard members', '9 credits for each active travel day', 'capped at 63 credits']),
    signature('flex-benefit-scope', 'Flex did not receive Quiet Month but retained Journey Guard.', ['Quiet Month rule did not apply', 'Journey Guard continued to apply']),
  ]),
  M12: anchor('M12', 12, [
    signature('mobility-supported-ferries', 'Mobility-disabled Supported members received unlimited ferries.', ['mobility disabilities', 'unlimited ferry crossings']),
    signature('assistant-travel', 'A registered assistant travelled free only while accompanying and received no independent membership.', ['personal assistant to travel free when accompanying', 'did not receive an independent Meridian membership']),
  ]),
  M13: anchor('M13', 13, [
    signature('journey-guard-25-rejected', 'The proposed 25-credit Journey Guard threshold was never approved.', ['proposed 25 credits', 'board never approved it']),
    signature('journey-guard-training-error', 'The 25-credit training slide was corrected as proposal-only.', ['training slide accidentally displayed', '25 credits had only been a proposal']),
  ]),
  M14: anchor('M14', 14, [
    signature('ferry-eight-trial', 'An eight-crossing trial began in October 2025 for Standard and ordinary Supported.', ['Beginning on 1 October 2025', 'increased from six to eight', 'Supported memberships also moved to eight']),
    signature('mobility-unlimited-persists', 'Mobility-disabled Supported members remained unlimited.', ['mobility-disabled Supported members', 'continued to have unlimited crossings']),
  ]),
  M15: anchor('M15', 15, [
    signature('ferry-eight-permanent', 'Eight crossings became permanent from January 2026.', ['eight-crossing allowance would become permanent from January 2026']),
    signature('standard-remains-55', 'Standard remained 55 credits.', ['Standard price would remain 55 credits']),
  ]),
  M16: anchor('M16', 16, [
    signature('standard-65-proposal', 'A 65-credit Standard rate was a budget scenario, not approved policy.', ['proposed a 65-credit Standard rate', 'budget scenario rather than an approved fare schedule']),
    signature('standard-final-55', 'The final notice retained 55 credits.', ['final December notice explicitly maintained the 55-credit rate']),
  ]),
  M17: anchor('M17', 17, [
    signature('quiet-month-2026-threshold', 'From March 2026 Quiet Month required fewer than four journeys.', ['From 1 March onward', 'fewer than four journeys']),
    signature('quiet-month-discount-timing', 'The discount remained 25 percent for the following month.', ['discount itself remained 25 percent', 'following month']),
  ]),
  M18: anchor('M18', 18, [
    signature('continuity-credit-introduction', 'Continuity Credit was introduced as a named loyalty benefit.', ['introduced a loyalty benefit known as Continuity Credit']),
    signature('continuity-credit-qualification', 'A Standard subscriber qualified after twelve uninterrupted paid months for a one-time 12-credit balance.', ['Standard subscriber', 'twelve consecutive months', 'one-time 12-credit account balance']),
    signature('continuity-credit-scope', 'Continuity Credit applied to supplemental charges, not subscription fees.', ['supplemental journey charges but not against the monthly subscription itself']),
  ]),
  M19: anchor('M19', 19, [
    signature('institutional-minimum-2026', 'The Institutional minimum block fell from fifty to twenty in May 2026.', ['minimum block size fell from fifty to twenty']),
    signature('institutional-rebate-persists', 'The 70 percent active-use rebate threshold persisted.', ['70 percent active-use threshold', 'remained unchanged']),
    signature('institutional-no-quiet-month', 'Institutional accounts remained ineligible for Quiet Month.', ['Quiet Month remained unavailable to them']),
    signature('university-exception-retained', 'Bellweather University retained its semester reassignment exception.', ['Bellweather University retained its semester reassignment exception']),
  ]),
  M20: anchor('M20', 20, [
    signature('flex-ended-dayline-started', 'Flex ended and Dayline became the approved usage-priced product.', ['Meridian Flex ended as a pilot', 'newly approved product called Meridian Dayline']),
    signature('dayline-pricing', 'Dayline charged 8 per active day with a monthly cap of 64.', ['8 credits per active travel day', 'monthly cap of 64 credits']),
    signature('dayline-availability', 'Dayline was available to any Bellweather resident.', ['available to any Bellweather resident']),
    signature('dayline-benefit-scope', 'Dayline had no Quiet Month and retained Journey Guard.', ['Dayline still did not qualify for Quiet Month', 'Journey Guard remained applicable']),
  ]),
  M21: anchor('M21', 21, [
    signature('dayline-display-exception', 'Seventy-two June users were honored at the displayed 63-credit cap.', ['Seventy-two users reached 63 credits', 'honoured the displayed cap']),
    signature('dayline-official-cap', 'The official future Dayline cap remained 64.', ['official Dayline cap for future billing', 'remained 64']),
  ]),
  M22: anchor('M22', 22, [
    signature('ferry-eight-not-universal', 'Eight included ferries was not universal.', ['all Meridian members receive eight ferry trips', 'not literally universal']),
    signature('ferry-exceptions', 'Mobility Supported remained unlimited while Dayline had no equivalent monthly allowance.', ['Mobility-disabled Supported members still had unlimited ferry crossings', 'Dayline members did not receive a monthly included-ferry allowance']),
    signature('most-subscriptions-eight', 'Most subscription members received eight included ferries.', ['most subscription members receive eight included ferry crossings']),
  ]),
  M23: anchor('M23', 23, [
    signature('meridian-north-not-category', 'Meridian North was a geographic expansion, not a membership category.', ['not a new membership category', 'planned geographic expansion']),
    signature('meridian-north-unlaunched', 'Meridian North had not launched by August 2026.', ['As of August 2026, Meridian North had not launched']),
  ]),
  M24: anchor('M24', 24, [
    signature('august-standard-state', 'In August 2026 Standard remained 55 with eight ferries.', ['By August 2026', 'Standard subscription therefore remained 55 credits', 'eight ferry crossings']),
    signature('august-journey-guard-state', 'Journey Guard still triggered above 18 per applicable journey.', ['Journey Guard still required confirmation above 18 credits']),
    signature('august-quiet-month-state', 'Quiet Month required fewer than four and discounted the next month by 25 percent.', ['updated Quiet Month threshold was fewer than four journeys', '25 percent reduction in September']),
  ]),
  M27: anchor('M27', 27, [
    signature('supported-current-example', 'A mobility Supported member paid 22 and had unlimited ferries.', ['paid 22 credits per month', 'unlimited ferry crossings']),
    signature('assistant-current-constraint', 'The assistant could travel only while accompanying.', ['assistant could travel free while accompanying', 'could not use that privilege to travel alone']),
    signature('supported-quiet-month', 'Supported remained eligible for Quiet Month.', ['could qualify for Quiet Month because Supported subscriptions remained eligible']),
  ]),
  M28: anchor('M28', 28, [
    signature('adaptive-membership-future', 'The adaptive membership was a September 2026 future proposal.', ['September 2026 strategy draft', 'future adaptive membership']),
    signature('adaptive-membership-unapproved', 'The adaptive plan and 28-credit base were discussion-only and unapproved.', ['base fee of 28 credits', 'discussion only', 'had not been approved']),
    signature('adaptive-not-current', 'The adaptive proposal could not answer current pricing or Quiet Month questions.', ['should not be used to answer questions about current Meridian pricing or current Quiet Month policy']),
  ]),
})

const proposition = (id, description, anchorIds, expectedSupport = 'supported') => Object.freeze({
  id,
  description,
  anchorIds: Object.freeze(anchorIds),
  expectedSupport,
})

const facet = (id, label, expectedTemporalOutcome, requiredPropositions, options = {}) => Object.freeze({
  id,
  label,
  required: options.required ?? true,
  critical: options.critical ?? true,
  expectedStatus: options.expectedStatus ?? 'covered',
  expectedTemporalOutcome,
  requiredPropositions: Object.freeze(requiredPropositions),
})

const synthesisCase = (id, question, expectedDisposition, facets, options = {}) => Object.freeze({
  id,
  question,
  asOf: options.asOf ?? PHASE5E_REFERENCE_AS_OF,
  expectedQueryMode: 'synthesis',
  expectedDisposition,
  facets: Object.freeze(facets),
  ...options,
})

export const PHASE5E_SYNTHESIS_CASES = Object.freeze([
  synthesisCase('S1', 'Summarise Meridian as it existed in August 2026. Exclude obsolete, proposed, pilot-only, or future rules.', 'answer', [
    facet('standard-plan', 'Standard plan', 'August 2026 current state', [
      proposition('standard-current-price', 'Standard costs 55 credits.', ['M15', 'M24']),
      proposition('standard-current-ferries', 'Standard includes eight ferry crossings.', ['M15', 'M24']),
    ]),
    facet('supported-plan', 'Supported plan', 'August 2026 current state with mobility exception', [
      proposition('supported-price', 'Supported costs 22 credits.', ['M12', 'M27']),
      proposition('supported-ferries', 'Ordinary Supported receives eight ferries while mobility Supported remains unlimited.', ['M12', 'M22', 'M27']),
      proposition('supported-assistant', 'Assistant travel is scoped to accompanying an eligible mobility member.', ['M12', 'M27']),
    ]),
    facet('institutional-plan', 'Institutional plan', 'August 2026 current purchasing and benefit structure', [
      proposition('institutional-block-model', 'Employers and universities purchase in blocks with a minimum of twenty.', ['M03', 'M19']),
      proposition('institutional-rebate', 'The 70 percent active-use rebate threshold remains.', ['M03', 'M19']),
      proposition('institutional-benefits', 'Institutional has no Quiet Month and allocated users generally receive eight ferries.', ['M19', 'M22']),
    ]),
    facet('dayline', 'Dayline', 'August 2026 current usage-priced product', [
      proposition('dayline-pricing', 'Dayline costs 8 per active day capped at 64.', ['M20']),
      proposition('dayline-availability', 'Dayline is available to any Bellweather resident.', ['M20']),
      proposition('dayline-benefits', 'Dayline has no Quiet Month or monthly ferry allowance and retains Journey Guard.', ['M20', 'M22']),
    ]),
    facet('quiet-month', 'Quiet Month', 'August 2026 applicability', [
      proposition('quiet-month-rule', 'Eligibility is fewer than four journeys and the 25 percent reduction applies next month.', ['M17', 'M24']),
      proposition('quiet-month-eligible-plans', 'Standard and Supported are eligible.', ['M17', 'M27']),
      proposition('quiet-month-excluded-plans', 'Institutional and Dayline are excluded.', ['M19', 'M20']),
    ]),
    facet('journey-guard', 'Journey Guard', 'August 2026 applicable threshold', [
      proposition('journey-guard-current', 'Confirmation is required above 18 supplemental credits for one journey.', ['M06', 'M24']),
      proposition('journey-guard-25-excluded', 'The 25-credit proposal never took effect.', ['M13']),
    ]),
    facet('ferry-policy', 'Ferry policy', 'August 2026 current allowance with scoped exceptions', [
      proposition('ferry-most-subscriptions', 'Most subscription members receive eight included ferries.', ['M14', 'M15', 'M22', 'M24']),
      proposition('ferry-exceptions', 'Mobility Supported is unlimited and Dayline has no monthly included allowance.', ['M22']),
    ]),
    facet('continuity-credit', 'Continuity Credit', 'Current named benefit introduced in March 2026', [
      proposition('continuity-credit-qualification', 'A Standard subscriber receives a one-time 12-credit balance after twelve uninterrupted paid months.', ['M18']),
      proposition('continuity-credit-use', 'The balance applies only to supplemental journey charges.', ['M18']),
    ]),
    facet('important-exceptions', 'Important exceptions', 'Exceptions remain scoped rather than generalized', [
      proposition('university-exception', 'Bellweather University alone retains semester reassignment.', ['M07']),
      proposition('accessibility-exceptions', 'Mobility ferry and assistant rules remain scoped.', ['M12', 'M22']),
      proposition('dayline-display-exception', 'Only the affected June users were honored at the displayed 63 cap.', ['M21']),
    ]),
    facet('inactive-or-proposed', 'Inactive or proposed rules', 'Excluded from August 2026 current policy', [
      proposition('flex-ended', 'Flex ended when Dayline launched.', ['M10', 'M20']),
      proposition('unapproved-numeric-rules', 'Journey Guard 25 and Standard 65 were unapproved.', ['M13', 'M16']),
      proposition('unlaunched-or-future', 'Meridian North was unlaunched and the adaptive plan was future discussion-only.', ['M23', 'M28']),
    ]),
  ], {
    singletonSalientForcing: Object.freeze({
      facetId: 'continuity-credit',
      anchorIds: Object.freeze(['M18']),
      expectedStructuralSignals: Object.freeze(['named-benefit', 'explicit-introduction']),
      recurrenceRequired: false,
      discoverBeforePerFacetRetrieval: true,
      benchmarkSeedAllowed: false,
      meridianSpecificRuleAllowed: false,
    }),
  }),

  synthesisCase('S2', 'Compare Standard, Supported, Institutional and Dayline as of August 2026.', 'answer', [
    facet('standard', 'Standard comparison row', 'August 2026; launch eligibility must be qualified as historical evidence', [
      proposition('standard-pricing-model', 'Fixed subscription at 55 credits.', ['M15', 'M24']),
      proposition('standard-users', 'Ordinary subscription; tourist/non-resident eligibility is launch-era evidence only.', ['M02']),
      proposition('standard-ferries', 'Eight included ferries.', ['M24']),
      proposition('standard-quiet-month', 'Eligible under the current threshold.', ['M17', 'M24']),
      proposition('standard-exception', 'Continuity Credit is Standard-only.', ['M18']),
    ]),
    facet('supported', 'Supported comparison row', 'August 2026 with launch-category provenance qualified', [
      proposition('supported-pricing-model', 'Fixed subscription at 22 credits.', ['M12', 'M27']),
      proposition('supported-users', 'Qualifying groups include the initially described categories and mobility subset.', ['M03', 'M12']),
      proposition('supported-ferries', 'Ordinary allowance eight; mobility allowance unlimited.', ['M22', 'M27']),
      proposition('supported-quiet-month', 'Eligible.', ['M27']),
      proposition('supported-exception', 'Assistant travel only while accompanying.', ['M12', 'M27']),
    ]),
    facet('institutional', 'Institutional comparison row', 'August 2026; pricing relationship remains provenance-qualified, not inferred numerically', [
      proposition('institutional-pricing-model', 'Block purchase with historically Standard-equivalent nominal price.', ['M03', 'M19']),
      proposition('institutional-users', 'Employers and universities purchase blocks with minimum twenty.', ['M19']),
      proposition('institutional-ferries', 'Allocated users generally receive eight.', ['M22']),
      proposition('institutional-quiet-month', 'Ineligible.', ['M19']),
      proposition('institutional-exceptions', 'The 70 percent rebate remains and university reassignment is customer-specific.', ['M07', 'M19']),
    ]),
    facet('dayline', 'Dayline comparison row', 'August 2026 current state', [
      proposition('dayline-pricing-model', '8 credits per active day capped at 64.', ['M20']),
      proposition('dayline-users', 'Available to any Bellweather resident.', ['M20']),
      proposition('dayline-ferries', 'No subscription-style monthly allowance.', ['M22']),
      proposition('dayline-quiet-month', 'Ineligible.', ['M20']),
      proposition('dayline-exception', 'The displayed 63 cap was honored for 72 June users only.', ['M21']),
    ]),
  ]),

  synthesisCase('S3', 'Explain the major Meridian policy changes from 2024 through August 2026.', 'answer', [
    facet('2024-launch-to-june', 'January-June 2024', 'Historical state retained in its valid period', [
      proposition('2024-launch', 'Standard launched at 40 with four ferries and three initial categories.', ['M02', 'M03']),
      proposition('2024-quiet-month', 'Quiet Month began at fewer than three with next-month 25 percent discount.', ['M04']),
      proposition('2024-journey-guard', 'Journey Guard began at 18 per journey.', ['M06']),
    ]),
    facet('2024-september', 'September 2024', 'Customer-specific historical exception', [
      proposition('2024-university', 'Bellweather University gained its reassignment exception.', ['M07']),
    ]),
    facet('2025-january-february', 'January-February 2025', 'Historical changes, later Flex obsolescence retained', [
      proposition('2025-standard-revision', 'Standard rose to 55 and ferries to six.', ['M08']),
      proposition('2025-flex-start', 'Flex began as a pilot.', ['M10']),
    ]),
    facet('2025-april', 'April 2025', 'Accessibility amendment becomes applicable', [
      proposition('2025-accessibility', 'Mobility Supported gained unlimited ferries and assistant travel.', ['M12']),
    ]),
    facet('2025-summer-december', 'Summer-December 2025', 'Actual ferry changes separated from rejected proposals', [
      proposition('2025-journey-guard-nonchange', 'The proposed 25 threshold was rejected.', ['M13']),
      proposition('2025-ferry-change', 'Eight ferries moved from trial to permanent 2026 policy.', ['M14', 'M15']),
      proposition('2025-price-nonchange', 'The proposed 65 rate was rejected and 55 retained.', ['M16']),
    ]),
    facet('2026-march-may', 'March-May 2026', 'Applicable 2026 policy changes', [
      proposition('2026-quiet-month', 'Quiet Month changed to fewer than four.', ['M17']),
      proposition('2026-continuity-credit', 'Continuity Credit began.', ['M18']),
      proposition('2026-institutional', 'Institutional minimum fell to twenty while rebate and no-Quiet rules persisted.', ['M19']),
    ]),
    facet('2026-june-august', 'June-August 2026', 'Current state and exceptions through the requested endpoint', [
      proposition('2026-dayline', 'Flex ended and Dayline began.', ['M20']),
      proposition('2026-dayline-display', 'The June display-cap exception did not change the official cap.', ['M21']),
      proposition('2026-ferry-clarification', 'Universal eight-ferry wording was corrected.', ['M22']),
      proposition('2026-north', 'Meridian North remained unlaunched.', ['M23']),
      proposition('2026-august-state', 'The August state was explicitly confirmed.', ['M24']),
    ]),
  ]),

  synthesisCase('S4', 'What important exceptions could make a general description of Meridian misleading?', 'answer', [
    facet('mobility-supported-ferries', 'Mobility Supported ferries', 'Current scoped exception', [
      proposition('mobility-ferries-unlimited', 'Mobility Supported receives unlimited rather than eight ferries.', ['M12', 'M22', 'M27']),
    ]),
    facet('assistant-travel', 'Assistant travel', 'Current scoped exception', [
      proposition('assistant-accompanying-only', 'Assistant travel is free only while accompanying, with no independent membership.', ['M12', 'M27']),
    ]),
    facet('bellweather-university', 'Bellweather University', 'Customer-specific exception retained in 2026', [
      proposition('university-reassignment-only', 'Semester reassignment applies only to Bellweather University.', ['M07', 'M19']),
    ]),
    facet('dayline-benefit-exclusions', 'Dayline benefit exclusions', 'Current product-specific exclusions', [
      proposition('dayline-no-quiet-or-ferries', 'Dayline has no Quiet Month or monthly included ferry allowance.', ['M20', 'M22']),
    ]),
    facet('dayline-display-error', 'Dayline display error', 'Historical honored exception, not current cap', [
      proposition('dayline-72-users', 'The 63 cap applied only to 72 affected June users; official cap remains 64.', ['M21']),
    ]),
    facet('quiet-month-audit', 'Quiet Month audit', 'Historical correction without policy termination', [
      proposition('quiet-month-audit-scope', 'Mistaken adjustments were honored and the audit did not end Quiet Month.', ['M05']),
    ]),
  ]),

  synthesisCase('S5', 'Which Meridian rules were proposed, mistaken, or discussed but were not current policy by August 2026?', 'answer', [
    facet('quiet-month-immediate-or-ended', 'Quiet Month immediate/end claim', 'False rather than August 2026 policy', [
      proposition('quiet-month-misstatement', 'Immediate discount and audit-ended claims were false.', ['M05']),
    ]),
    facet('journey-guard-monthly-cap', 'Journey Guard monthly-cap claim', 'False rather than current policy', [
      proposition('journey-guard-not-cap', 'Journey Guard is per journey, not an 18-credit monthly cap.', ['M06']),
    ]),
    facet('discounted-standard-30', 'Thirty-credit Standard discount', 'Historically correct but obsolete', [
      proposition('standard-30-obsolete', 'Thirty credits was a 2024 calculation; current discounted price is 41.25.', ['M09']),
    ]),
    facet('flex-current-product', 'Flex current-product claim', 'Obsolete pilot by August 2026', [
      proposition('flex-obsolete', 'Flex ended and Dayline replaced it as the approved option.', ['M10', 'M20']),
    ]),
    facet('journey-guard-25', 'Journey Guard 25', 'Proposed/training error, never approved', [
      proposition('journey-guard-25-rejected', 'The 25-credit threshold never took effect.', ['M13']),
    ]),
    facet('standard-65', 'Standard 65', 'Budget proposal rejected before 2026 current state', [
      proposition('standard-65-rejected', 'The 65-credit proposal was not approved; 55 remained.', ['M15', 'M16']),
    ]),
    facet('dayline-63', 'Dayline 63', 'Display exception, not official future billing cap', [
      proposition('dayline-63-display-only', 'The 63 cap was honored for affected users only; official cap is 64.', ['M20', 'M21']),
    ]),
    facet('universal-eight-ferries', 'Universal eight ferries', 'Overgeneralization rather than current universal rule', [
      proposition('ferries-not-universal', 'Mobility Supported and Dayline make the universal claim false.', ['M22']),
    ]),
    facet('meridian-north-membership', 'Meridian North membership', 'Unlaunched expansion, not a category', [
      proposition('north-not-current-membership', 'Meridian North was neither launched nor a membership category.', ['M23']),
    ]),
    facet('adaptive-membership', 'Adaptive membership', 'After asOf, discussion-only, unapproved', [
      proposition('adaptive-not-current', 'The 28-credit adaptive proposal did not replace August plans.', ['M28']),
    ]),
  ]),

  synthesisCase('S6', 'Give the exact number of Meridian members using every membership type in August 2026 and their average monthly expenditure.', 'refuse-unsupported', [
    facet('standard-member-count', 'Standard August member count', 'Requested August aggregate is absent', [
      proposition('standard-count-missing', 'Exact Standard August member count is not provided.', [], 'unsupported'),
    ], { expectedStatus: 'unsupported' }),
    facet('standard-average-expenditure', 'Standard average expenditure', 'Requested August aggregate is absent', [
      proposition('standard-average-missing', 'Standard average monthly expenditure is not provided.', [], 'unsupported'),
    ], { expectedStatus: 'unsupported' }),
    facet('supported-member-count', 'Supported August member count', 'Requested August aggregate is absent', [
      proposition('supported-count-missing', 'Exact Supported August member count is not provided.', [], 'unsupported'),
    ], { expectedStatus: 'unsupported' }),
    facet('supported-average-expenditure', 'Supported average expenditure', 'Requested August aggregate is absent', [
      proposition('supported-average-missing', 'Supported average monthly expenditure is not provided.', [], 'unsupported'),
    ], { expectedStatus: 'unsupported' }),
    facet('institutional-member-count', 'Institutional August member count', 'Requested August aggregate is absent', [
      proposition('institutional-count-missing', 'Exact Institutional August member count is not provided.', [], 'unsupported'),
    ], { expectedStatus: 'unsupported' }),
    facet('institutional-average-expenditure', 'Institutional average expenditure', 'Requested August aggregate is absent', [
      proposition('institutional-average-missing', 'Institutional average monthly expenditure is not provided.', [], 'unsupported'),
    ], { expectedStatus: 'unsupported' }),
    facet('dayline-member-count', 'Dayline August member count', 'Requested August aggregate is absent', [
      proposition('dayline-count-missing', 'Exact Dayline August member count is not provided.', [], 'unsupported'),
    ], { expectedStatus: 'unsupported' }),
    facet('dayline-average-expenditure', 'Dayline average expenditure', 'Requested August aggregate is absent', [
      proposition('dayline-average-missing', 'Dayline average monthly expenditure is not provided.', [], 'unsupported'),
    ], { expectedStatus: 'unsupported' }),
  ], {
    activeTypeAnchorIds: Object.freeze(['M19', 'M20', 'M22', 'M24']),
    mustNotSubstituteAnchorIds: Object.freeze(['M05', 'M07', 'M10', 'M21']),
    expectedUnsupportedMetricCells: Object.freeze([
      'standard-member-count',
      'standard-average-expenditure',
      'supported-member-count',
      'supported-average-expenditure',
      'institutional-member-count',
      'institutional-average-expenditure',
      'dayline-member-count',
      'dayline-average-expenditure',
    ]),
  }),
])

const focusedControl = (id, question, expectedDisposition, expectedTemporalOutcome, requiredPropositions) => Object.freeze({
  id,
  question,
  asOf: PHASE5E_REFERENCE_AS_OF,
  expectedQueryMode: 'focused',
  expectedDisposition,
  expectedTemporalOutcome,
  requiredPropositions: Object.freeze(requiredPropositions),
})

export const PHASE5E_FOCUSED_CONTROLS = Object.freeze([
  focusedControl('F1', 'What was the Standard price in August 2026?', 'answer', '55 is applicable; 40 is superseded and 65 unapproved', [
    proposition('f1-standard-55', 'Standard is 55 in August 2026.', ['M15', 'M16', 'M24']),
  ]),
  focusedControl('F2', 'What did Standard cost in 2024?', 'answer', '40 is applicable to the named historical period', [
    proposition('f2-standard-40', 'Standard cost 40 in 2024.', ['M02', 'M08']),
  ]),
  focusedControl('F3', 'Did the proposed 25-credit Journey Guard threshold take effect?', 'answer', 'No; 18 remained operative', [
    proposition('f3-journey-guard-18', 'The 25 proposal failed and 18 remained.', ['M13', 'M24']),
  ]),
  focusedControl('F4', 'Does Dayline qualify for Quiet Month?', 'answer', 'No; Dayline is excluded', [
    proposition('f4-dayline-no-quiet', 'Dayline does not qualify for Quiet Month.', ['M20']),
  ]),
  focusedControl('F5', 'What is the exact average monthly expenditure of a Supported member in August 2026?', 'refuse-unsupported', 'The requested aggregate is absent', [
    proposition('f5-supported-average-missing', 'Supported average monthly expenditure is not provided.', [], 'unsupported'),
  ]),
])
