export type SportId = 'soccer' | 'football' | 'lacrosse';
export type Verdict = 'FAIR_CALL' | 'BAD_CALL' | 'INCONCLUSIVE';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface RuleSource {
  /** Deep link to the official rulebook passage. Must be a real, verified URL. */
  url: string;
  /** Publisher shorthand, e.g. 'IFAB' | 'NFL' | 'NCAA'. */
  publisher: string;
  /** Human-readable citation, e.g. 'IFAB Laws of the Game — Law 11: Offside'. */
  label: string;
}

export interface CitedRule {
  code: string;
  title: string;
  text: string;
  source?: RuleSource;
}

export interface AnalyzeResponse {
  sport: SportId;
  verdict: Verdict;
  confidence: Confidence;
  playDescription: string;
  reasoning: string;
  rulesCited: CitedRule[];
  originalCall: string | null;
  processingMs: number;
  annotatedVideoBase64?: string;

  /* ---------------------------------------------------------------- */
  /* Graph fields (backend/graph/run.ts)                               */
  /*                                                                   */
  /* This interface is shared and frozen, so every field the analysis  */
  /* graph adds is OPTIONAL and every one of them is additive. A client */
  /* that predates the graph renders exactly what it rendered before.   */
  /* ---------------------------------------------------------------- */

  /** Artifact directory id: backend/runs/<runId>/. */
  runId?: string;
  /** Actionable band derived from `reliabilityScore`. */
  reliability?: 'TRUSTWORTHY' | 'REVIEW_SUGGESTED' | 'UNRELIABLE';
  /** 0..1 after the observation and audit penalties. THE number to trust. */
  reliabilityScore?: number;
  /** 0..1 from council agreement alone, before those penalties. */
  accuracyScore?: number;
  /**
   * True when this result was HELD by the human gate. A client showing this as
   * a plain verdict is showing an answer the system does not stand behind.
   */
  needsHumanReview?: boolean;
  /** Why the gate fired, in plain language. Empty when it did not. */
  reviewReasons?: string[];
  /** Facts the two observers could not agree on. */
  contested?: string[];
  /** How far council escalation went before settling. */
  stage?: 'panel' | 'debate' | 'chair';
  /** The panel spread, for showing dissent instead of hiding it. */
  panel?: { role: string; verdict: Verdict; confidence: Confidence }[];
}

export type ErrorCode =
  | 'FILE_TOO_LARGE' | 'BAD_FORMAT' | 'MODEL_ERROR'
  | 'TIMEOUT' | 'RATE_LIMIT' | 'UNSUPPORTED_SPORT';

export interface AnalyzeError {
  error: string;
  code: ErrorCode;
}

export interface SportRule {
  code: string;
  title: string;
  text: string;
  keywords: string[];
  callTypes: string[];
  needsVerification?: boolean;
  source: RuleSource;
}

export interface SportCorpus {
  id: SportId;
  displayName: string;
  governingBody: string;
  officialTitle: string;
  analystPersona: string;
  observationHints: string;
  commonCalls: string[];
  rules: SportRule[];
}
