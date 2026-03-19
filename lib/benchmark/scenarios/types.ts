export type TurnRole = "user" | "interviewer";

export type ExpectedBehavior =
  | "guide_user"
  | "clarify_without_leading"
  | "check_in_appropriately"
  | "acknowledge_without_evaluating"
  | "note_feedback"
  | "adapt_to_conditions";

export interface ScenarioTurn {
  role: TurnRole;
  text?: string;
  expectedBehavior?: ExpectedBehavior;
  silenceDurationSeconds?: number;
  noiseLevel?: "clean" | "light" | "moderate";
  snrDb?: number;
  interruptionAtPercent?: number;
  interruptionText?: string;
}

export interface Scenario {
  name: string;
  description: string;
  turns: ScenarioTurn[];
}

export interface ScenarioVariant extends Scenario {
  parentScenario: string;
}

export const EVALUATION_DIMENSIONS = [
  {
    id: "transcriptionAccuracy",
    name: "Transcription Accuracy",
    prompt: "How accurately did the system transcribe what the user said?",
  },
  {
    id: "responseRelevance",
    name: "Response Relevance",
    prompt: "How relevant was the response to the user's input?",
  },
  {
    id: "voiceNaturalness",
    name: "Voice Naturalness",
    prompt: "How natural did the voice sound?",
  },
  {
    id: "conversationFlow",
    name: "Conversation Flow",
    prompt: "How smoothly did the conversation flow?",
  },
  {
    id: "professionalism",
    name: "Professionalism",
    prompt: "How professional was the interviewer's conduct?",
  },
  {
    id: "overallQuality",
    name: "Overall Quality",
    prompt: "Would you use this for real UX research?",
  },
] as const;

export type EvaluationDimensionId = (typeof EVALUATION_DIMENSIONS)[number]["id"];
export type RatingScore = 1 | 2 | 3;
export const RATING_LABELS: Record<RatingScore, string> = { 1: "Bad", 2: "Acceptable", 3: "Good" };
