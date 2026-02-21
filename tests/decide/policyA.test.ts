import { describe, it, expect } from 'vitest';
import { runPolicyA } from '@/lib/decide/policyA';
import type { DecideInput } from '@/lib/decide/types';

const base: DecideInput = {
  taskTimeSec: 30,
  taskLabel: "Find the checkout button",
  engagementState: { state: "engaged_active", confidence: 0.8 },
  mouseSummary: { inactiveSec: 2, erraticness: 0.2, repeatClicksSameRegion: 0, scrollBursts: 0 },
  conversationCues: {
    explicitUncertaintyCount: 0, clarificationCount: 0, negAffectCount: 0,
    veryLongPauseCount: 0, longPauseCount: 0, repairsPer100w: 0,
    repetitionsPer100w: 0, hedgesPer100w: 0, repeatAttemptLoopFlag: false, clarityIndex: 2,
  },
  hardOverrides: { mustMoveOn: false, reason: "" },
};

describe('Policy A — runPolicyA', () => {
  it('Step 0: hard override forces move_to_next_task', () => {
    const result = runPolicyA({ ...base, hardOverrides: { mustMoveOn: true, reason: "timeout" } });
    expect(result.action).toBe("move_to_next_task");
    expect(result.probeType).toBe("move_on");
    expect(result.confidence).toBe(0.95);
  });

  it('Step 1: disengaged_away + inactive >= 8 → move_to_next_task', () => {
    const result = runPolicyA({
      ...base,
      engagementState: { state: "disengaged_away", confidence: 0.7 },
      mouseSummary: { ...base.mouseSummary, inactiveSec: 10 },
    });
    expect(result.action).toBe("move_to_next_task");
    expect(result.confidence).toBe(0.85);
  });

  it('Step 1: disengaged_away + inactive < 8 → reflect_back', () => {
    const result = runPolicyA({
      ...base,
      engagementState: { state: "disengaged_away", confidence: 0.7 },
      mouseSummary: { ...base.mouseSummary, inactiveSec: 3 },
    });
    expect(result.action).toBe("reflect_back");
    expect(result.probeType).toBe("emotion_checkin");
  });

  it('Step 2: neg affect → ask_followup system_status', () => {
    const result = runPolicyA({ ...base, conversationCues: { ...base.conversationCues, negAffectCount: 1 } });
    expect(result.action).toBe("ask_followup");
    expect(result.probeType).toBe("system_status");
    expect(result.confidence).toBe(0.90);
  });

  it('Step 2: repeat attempt loop → ask_followup system_status', () => {
    const result = runPolicyA({ ...base, conversationCues: { ...base.conversationCues, repeatAttemptLoopFlag: true } });
    expect(result.action).toBe("ask_followup");
    expect(result.probeType).toBe("system_status");
  });

  it('Step 3: explicit uncertainty → ask_followup comprehension', () => {
    const result = runPolicyA({ ...base, conversationCues: { ...base.conversationCues, explicitUncertaintyCount: 1 } });
    expect(result.action).toBe("ask_followup");
    expect(result.probeType).toBe("comprehension");
  });

  it('Step 4: STUCK_SCORE >= 2 → ask_followup expectation', () => {
    const result = runPolicyA({
      ...base,
      conversationCues: { ...base.conversationCues, veryLongPauseCount: 1, longPauseCount: 3 },
    });
    expect(result.action).toBe("ask_followup");
    expect(result.probeType).toBe("expectation");
  });

  it('Step 6: smooth progress → wait', () => {
    const result = runPolicyA(base); // base is all-clear
    expect(result.action).toBe("wait");
    expect(result.probeType).toBe("none");
  });
});
