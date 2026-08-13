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

/** Result of running one arm (baseline or council) over one case. */
export interface CaseOutcome {
  caseId: string;
  arm: 'baseline' | 'council';
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
  difficulty: GoldenCase['difficulty'];
  tag: string;
  error?: string;
  latencyMs: number;
  modelCalls: number;
}

export interface ArmMetrics {
  arm: 'baseline' | 'council';
  n: number;
  verdictAccuracy: number;
  /** Macro-averaged over the three verdict classes — guards against a model
   *  that games accuracy by always answering the majority class. */
  macroF1: number;
  perVerdict: Record<Verdict, { precision: number; recall: number; f1: number; support: number }>;
  meanRulePrecision: number;
  meanRuleRecall: number;
  meanRuleF1: number;
  retrievalHitRate: number;
  /** Expected Calibration Error over 10 bins: does claimed confidence match
   *  observed accuracy? A council that is right 70% of the time and says so
   *  is more useful than one right 75% that always claims 99%. */
  ece: number;
  /** Brier score (lower is better) on the correctness indicator. */
  brier: number;
  accuracyByDifficulty: Record<GoldenCase['difficulty'], { n: number; accuracy: number }>;
  meanLatencyMs: number;
  totalModelCalls: number;
  errorRate: number;
}

export interface ComparisonReport {
  generatedAt: string;
  goldenVersion: string;
  sports: SportId[];
  baseline: ArmMetrics;
  council: ArmMetrics;
  delta: {
    verdictAccuracy: number;
    macroF1: number;
    meanRuleF1: number;
    ece: number;
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
}
