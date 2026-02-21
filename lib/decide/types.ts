export type Action = "ask_followup" | "clarify_task" | "reflect_back" | "move_to_next_task" | "wait";

export type ProbeType =
  | "expectation" | "comprehension" | "navigation"
  | "system_status" | "emotion_checkin" | "move_on" | "none";

export interface DecideInput {
  taskTimeSec: number;
  taskLabel: string;
  engagementState: {
    state: "engaged_active" | "engaged_stuck" | "disengaged_away" | "uncertain_low_confidence";
    confidence: number;
  };
  mouseSummary: {
    inactiveSec: number;
    erraticness: number;
    repeatClicksSameRegion: number;
    scrollBursts: number;
  };
  conversationCues: {
    explicitUncertaintyCount: number;
    clarificationCount: number;
    negAffectCount: number;
    veryLongPauseCount: number;
    longPauseCount: number;
    repairsPer100w: number;
    repetitionsPer100w: number;
    hedgesPer100w: number;
    repeatAttemptLoopFlag: boolean;
    clarityIndex: number;
  };
  hardOverrides: {
    mustMoveOn: boolean;
    reason: string;
  };
}

export interface DecideOutput {
  action: Action;
  probeType: ProbeType;
  nextPrompt: string;
  rationale: string;
  confidence: number;
}
