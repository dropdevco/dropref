export type SportId = 'soccer' | 'football' | 'lacrosse';
export type Verdict = 'FAIR_CALL' | 'BAD_CALL' | 'INCONCLUSIVE';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface CitedRule {
  code: string;
  title: string;
  text: string;
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
