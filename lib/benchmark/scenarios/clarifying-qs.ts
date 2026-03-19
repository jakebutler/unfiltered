import type { Scenario } from "./types";

export const clarifyingQuestions: Scenario = {
  name: "clarifying_questions",
  description: "User expresses confusion, interviewer guides without leading",
  turns: [
    { role: "user", text: "I'm not sure what this button does..." },
    { role: "interviewer", expectedBehavior: "clarify_without_leading" },
    { role: "user", text: "I'm confused about the navigation here. I don't see where to go next." },
    { role: "interviewer", expectedBehavior: "guide_user" },
    { role: "user", text: "Oh wait, I see it now. Never mind." },
    { role: "interviewer", expectedBehavior: "note_feedback" },
  ],
};

export const clarifyingQuestionsExtended: Scenario = {
  name: "clarifying_questions_extended",
  description: "Extended confusion requiring multiple guidance rounds",
  turns: [
    { role: "user", text: "What am I supposed to do on this page?" },
    { role: "interviewer", expectedBehavior: "clarify_without_leading" },
    { role: "user", text: "I still don't understand. Is there a specific thing I should click?" },
    { role: "interviewer", expectedBehavior: "guide_user" },
    { role: "user", text: "I guess I'll just look around..." },
    { role: "user", text: "Actually, I think I found it. This is confusing though." },
    { role: "interviewer", expectedBehavior: "note_feedback" },
  ],
};
