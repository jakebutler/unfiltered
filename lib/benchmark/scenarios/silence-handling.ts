import type { Scenario } from "./types";

export const silenceHandling: Scenario = {
  name: "silence_handling",
  description: "User pauses 5-15 seconds, interviewer handles appropriately",
  turns: [
    { role: "user", text: "So I'm looking at this product page..." },
    { role: "user", text: "", silenceDurationSeconds: 10 },
    { role: "interviewer", expectedBehavior: "check_in_appropriately" },
    { role: "user", text: "Hmm, I see the size options here." },
  ],
};

export const silenceHandlingLong: Scenario = {
  name: "silence_handling_long",
  description: "Extended silence (15+ seconds) requiring check-in",
  turns: [
    { role: "user", text: "Let me find the checkout button..." },
    { role: "user", text: "", silenceDurationSeconds: 15 },
    { role: "interviewer", expectedBehavior: "check_in_appropriately" },
    { role: "user", text: "Oh, sorry. I was looking for the button. I found it now." },
    { role: "interviewer", expectedBehavior: "note_feedback" },
  ],
};

export const silenceThinking: Scenario = {
  name: "silence_thinking",
  description: "Thinking aloud with natural pauses — should not interrupt",
  turns: [
    { role: "user", text: "Let me see... I need to compare these options..." },
    { role: "user", text: "", silenceDurationSeconds: 5 },
    { role: "user", text: "The first one has better reviews..." },
    { role: "user", text: "", silenceDurationSeconds: 4 },
    { role: "user", text: "But the second one is cheaper." },
  ],
};
