import type { SportId, Verdict } from '../../types/contract';

/**
 * One labeled case in the golden set.
 *
 * These are TEXT-level: they start from an observation string, skipping the
 * video stage. That is deliberate — it isolates the retrieval + adjudication
 * stages, which is exactly where the council operates, so a measured delta is
 * attributable to the council rather than to vision noise.
 */
export interface GoldenCase {
  /** Stable id, e.g. 'soccer-offside-004'. */
  id: string;
  sport: SportId;
  /** The observation text, phrased the way stage-1 actually writes them. */
  observation: string;
  /** The referee's call, or null to exercise no-call (ruling) mode. */
  originalCall: string | null;
  /** Ground-truth verdict. */
  expectedVerdict: Verdict;
  /**
   * Unique rule refs (see backend/council/rule-ref.ts) that SHOULD be cited.
   * Empty array is valid and meaningful for INCONCLUSIVE cases.
   */
  expectedRuleRefs: string[];
  /**
   * How hard this case is. Lets us report accuracy per difficulty band —
   * a council that only helps on 'hard' cases is still a win, but averaging
   * it with 'easy' cases hides that.
   */
  difficulty: 'easy' | 'medium' | 'hard';
  /**
   * What this case is probing, e.g. 'level-is-onside', 'ball-first-tackle'.
   * Used to spot systematic blind spots.
   */
  tag: string;
  /** Why this is the right answer, citing the rulebook. Human review aid. */
  rationale: string;
}

export interface GoldenSet {
  sport: SportId;
  version: string;
  cases: GoldenCase[];
}

/**
 * WHAT KIND of quantity `CaseOutcome.claimedProbability` holds.
 *
 * This exists because the two arms do not emit the same kind of number, and
 * pretending they do was a real measurement defect (B1):
 *
 *  - 'self_probability' — the model's own normalised `selfProbability`, on the
 *    full [0, 1] range. This is what the BASELINE arm emits (see
 *    backend/council/index.ts, runSingleModel).
 *  - 'council_formula'  — the `accuracyScore` composite
 *    (0.4*consensus + 0.3*meanProbability + 0.2*(1-entropy) + 0.1*citation).
 *    On the settled path a 3-seat panel at consensusThreshold 0.75 must be
 *    unanimous, which pins consensusRatio = 1 and verdictEntropy = 0, so the
 *    composite degenerates to 0.7 + 0.3 * p_self — an affine rescale confined
 *    to [0.70, 1.00].
 *
 * An ECE/Brier delta between an arm on [0, 1] and an arm on [0.70, 1.00] is
 * dominated by that offset interacting with the base rate, NOT by the council:
 * on a null experiment where the council answers IDENTICALLY to the baseline,
 * ECE moves and even changes sign as the base rate varies. Recording the kind
 * makes the asymmetry explicit in the JSON, and is why AUROC — invariant under
 * any monotone rescale — is the discrimination headline.
 */
export type ScoreKind = 'self_probability' | 'council_formula';

/**
 * The arms the harness can run.
 *
 *  - 'baseline' — one model, one call (backend/council runSingleModel)
 *  - 'council'  — the adjudication sub-graph alone (runCouncil)
 *  - 'graph'    — council + the evidence auditor + the reliability composition
 *                 (backend/graph/run.ts graphArm)
 *
 * The graph arm enters BELOW the observer nodes, because a golden case supplies
 * a single hand-written observation and no clip. It therefore measures the
 * auditor's contribution and nothing about the observer fan-out; see the
 * limitation noted in backend/graph/run.ts.
 */
export type ArmName = 'baseline' | 'council' | 'graph';

/** Result of running one arm over one case. */
export interface CaseOutcome {
  caseId: string;
  arm: ArmName;
  expectedVerdict: Verdict;
  actualVerdict: Verdict;
  verdictCorrect: boolean;
  expectedRuleRefs: string[];
  actualRuleRefs: string[];
  /** |expected ∩ actual| / |actual| — did it cite junk? */
  rulePrecision: number;
  /** |expected ∩ actual| / |expected| — did it find the right rule? */
  ruleRecall: number;
  ruleF1: number;
  /** Whether retrieval even put a correct rule in the shortlist. Separates
   *  retrieval failure from adjudication failure — different fixes. */
  retrievalHit: boolean;
  /** The arm's own 0..1 accuracy estimate, for calibration scoring. */
  claimedProbability: number;
  /** WHICH kind of quantity `claimedProbability` is. See ScoreKind. */
  scoreKind: ScoreKind;
  difficulty: GoldenCase['difficulty'];
  tag: string;
  error?: string;
  latencyMs: number;
  modelCalls: number;
}

/**
 * Which case set a block of figures was computed over.
 *
 *  - 'paired'   — ONLY cases that BOTH arms scored (present in both arms and
 *                 errored in neither). The only basis on which a cross-arm
 *                 delta means anything.
 *  - 'unpaired' — this arm's OWN scored set. Each arm gets a different
 *                 denominator, so these numbers are NOT comparable across arms
 *                 and no delta may be taken between them.
 */
export type MetricBasis = 'paired' | 'unpaired';

/**
 * One arm's own figures, on its own denominator.
 *
 * Reported next to `errorRate` because that is what they are for: seeing that
 * an arm's own scored set differs from the paired set, and by how much.
 *
 * DO NOT subtract one arm's `unpaired.verdictAccuracy` from the other's. That
 * subtraction is defect B2 — when the council errors on cases the baseline
 * scored, the council's denominator shrinks and its accuracy is flattered.
 */
export interface UnpairedArmFigures {
  /** This arm's own scored-case count — its own denominator. */
  scoredN: number;
  verdictAccuracy: number;
  macroF1: number;
  meanRuleF1: number;
  auroc: number;
  eceRaw: number;
  brierRaw: number;
  accuracyByDifficulty: Record<GoldenCase['difficulty'], { n: number; accuracy: number }>;
}

export interface ArmMetrics {
  arm: ArmName;
  /**
   * WHICH case set every headline field below was computed over. When this is
   * 'paired' the numbers are cross-arm comparable; when it is 'unpaired' they
   * are not, and `compare()` refuses to build a report from them.
   */
  basis: MetricBasis;
  /** Cases this arm ATTEMPTED, errors included. Never a metric denominator. */
  n: number;
  /** The denominator of every headline field below, on `basis`. */
  scoredN: number;
  verdictAccuracy: number;
  /** Macro-averaged over the three verdict classes — guards against a model
   *  that games accuracy by always answering the majority class. */
  macroF1: number;
  perVerdict: Record<Verdict, { precision: number; recall: number; f1: number; support: number }>;
  meanRulePrecision: number;
  meanRuleRecall: number;
  meanRuleF1: number;
  /**
   * Area under the ROC curve of claimedProbability against the correctness
   * indicator: given one correct and one incorrect case, the probability the
   * arm scored the correct one higher. 0.5 is chance.
   *
   * THE discrimination headline, because it is invariant under ANY strictly
   * monotone rescale of the claimed probability — including the council's
   * `p -> 0.7 + 0.3p` degeneration — so it cannot manufacture a delta out of
   * an arbitrary offset the way ECE can (defect B1).
   */
  auroc: number;
  /** ECE over 10 bins on the RAW claimed probability, as the arm emitted it. */
  eceRaw: number;
  /**
   * ECE after a monotone (isotonic) recalibration fitted OUT OF FOLD on this
   * arm's own scores. Strips the arbitrary-rescale component, so what is left
   * is the miscalibration no monotone rescale could have fixed.
   */
  eceRecalibrated: number;
  /** Brier on the RAW claimed probability. */
  brierRaw: number;
  /** Brier after the same out-of-fold isotonic recalibration. */
  brierRecalibrated: number;
  accuracyByDifficulty: Record<GoldenCase['difficulty'], { n: number; accuracy: number }>;
  meanLatencyMs: number;
  totalModelCalls: number;
  errorRate: number;
  /** What kind of quantity this arm's claimed probabilities are. See ScoreKind. */
  scoreKind: ScoreKind | 'mixed' | 'none';
  /**
   * This arm's OWN-denominator figures. Present only on a 'paired' block, so
   * the paired and unpaired numbers can never be mistaken for one another.
   */
  unpaired?: UnpairedArmFigures;
}

/** How the paired intersection was formed, and what forming it cost. */
export interface PairingSummary {
  /** Size of the intersection — the denominator of every headline figure. */
  pairedCases: number;
  baselineAttempted: number;
  councilAttempted: number;
  /** Case ids present in one arm but not the other. */
  unpairedCaseIds: string[];
  /** Case ids dropped because at least one arm errored on them. */
  erroredCaseIds: { baselineOnly: string[]; councilOnly: string[]; both: string[] };
  /**
   * The accuracy delta you get from each arm's OWN denominator — i.e. the
   * WRONG number (defect B2). Kept in the report deliberately: the gap between
   * this and `pairedAccuracyDelta` is exactly how much improvement the per-arm
   * denominators were inventing.
   */
  unpairedAccuracyDelta: number;
  /** The honest delta, over the intersection. This is `delta.verdictAccuracy`. */
  pairedAccuracyDelta: number;
}

/** Facts about the RUN that are not properties of either arm. */
export interface RunMetadata {
  /**
   * Fraction of cases whose expected rule ref made it into the retrieval
   * shortlist.
   *
   * NOT an arm metric and deliberately NOT in the comparison table: it depends
   * only on the golden set and `prepareCase()`, both identical for both arms,
   * so a do-nothing stub arm scores exactly the same and its "delta" is 0 by
   * construction. It measures backend/rules/retrieve.ts, and it caps what any
   * arm could possibly achieve.
   */
  retrievalHitRate: number;
  /**
   * Cases where the two arms disagreed about `retrievalHit`. Should always be
   * empty — if it is not, `prepareCase()` is not deterministic and the whole
   * comparison is suspect.
   */
  retrievalHitDisagreements: string[];
  /** Hash of everything that changes the answers. See backend/eval/fingerprint.ts. */
  configFingerprint?: string;
  /** Outcomes served from the resume cache, per arm. Non-zero means the run did
   *  NOT re-invoke the arm for those cases. */
  cacheHits?: Partial<Record<ArmName, number>>;
}

export interface ComparisonReport {
  generatedAt: string;
  goldenVersion: string;
  sports: SportId[];
  /**
   * Both arms' metrics on the PAIRED intersection (`basis === 'paired'`).
   * Their `.unpaired` sub-blocks carry the per-arm figures.
   */
  baseline: ArmMetrics;
  council: ArmMetrics;
  pairing: PairingSummary;
  runMetadata: RunMetadata;
  /** Every delta here is PAIRED. There is no unpaired delta in this object;
   *  the wrong one is quarantined in `pairing.unpairedAccuracyDelta`. */
  delta: {
    verdictAccuracy: number;
    macroF1: number;
    meanRuleF1: number;
    auroc: number;
    eceRaw: number;
    eceRecalibrated: number;
    brierRaw: number;
    meanLatencyMs: number;
    totalModelCalls: number;
  };
  /**
   * McNemar exact test over cases where the two arms disagree. Without this,
   * a +3pp swing on 45 cases is indistinguishable from noise, and "the council
   * improves results" would be an unfalsifiable claim.
   */
  significance: {
    baselineOnlyCorrect: number;
    councilOnlyCorrect: number;
    pValue: number;
    significant: boolean;
  };
  /** Cases the council got wrong that baseline got right — regression list. */
  regressions: string[];
  /** Cases the council fixed. */
  fixes: string[];
  verdict: 'COUNCIL_BETTER' | 'NO_SIGNIFICANT_DIFFERENCE' | 'COUNCIL_WORSE';
  /** Caveats that must be printed WITH the numbers, not buried. */
  caveats: string[];
}
