import type { Scenario } from "./types";

export const adverseNoise: Scenario = {
  name: "adverse_noise",
  description: "Background noise during session",
  turns: [
    { role: "user", text: "I can't hear you very well, there's some background noise.", noiseLevel: "moderate", snrDb: 10 },
    { role: "interviewer", expectedBehavior: "adapt_to_conditions" },
    { role: "user", text: "Can you hear me now? I moved to a quieter spot.", noiseLevel: "light", snrDb: 20 },
    { role: "interviewer", text: "Yes, much better. Please continue with the task." },
  ],
};

export const adverseInterruption: Scenario = {
  name: "adverse_interruption",
  description: "User interrupts interviewer mid-response",
  turns: [
    { role: "interviewer", text: "Let me summarize what you've said so far. You found the navigation...", interruptionAtPercent: 30, interruptionText: "Sorry, can I add something?" },
    { role: "user", text: "Sorry, can I add something?" },
    { role: "interviewer", expectedBehavior: "guide_user" },
    { role: "user", text: "I wanted to mention that the loading times were really fast." },
    { role: "interviewer", expectedBehavior: "note_feedback" },
  ],
};

export const adverseHeavyNoise: Scenario = {
  name: "adverse_heavy_noise",
  description: "Heavy background noise (10dB SNR) throughout",
  turns: [
    { role: "user", text: "I'm at a cafe so there might be some noise.", noiseLevel: "moderate", snrDb: 10 },
    { role: "interviewer", expectedBehavior: "adapt_to_conditions" },
    { role: "user", text: "I'm looking at the homepage now.", noiseLevel: "moderate", snrDb: 10 },
    { role: "interviewer", expectedBehavior: "guide_user" },
    { role: "user", text: "I found the search bar.", noiseLevel: "moderate", snrDb: 10 },
  ],
};
