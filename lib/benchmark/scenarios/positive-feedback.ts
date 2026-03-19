import type { Scenario } from "./types";

export const positiveFeedback: Scenario = {
  name: "positive_feedback",
  description: "User praises feature, interviewer acknowledges neutrally",
  turns: [
    { role: "user", text: "Oh this is really clear, I like the big button." },
    { role: "interviewer", expectedBehavior: "acknowledge_without_evaluating" },
    { role: "user", text: "This feature is great, very intuitive." },
    { role: "interviewer", expectedBehavior: "note_feedback" },
    { role: "user", text: "I'll add this to my cart." },
  ],
};

export const mixedFeedback: Scenario = {
  name: "mixed_feedback",
  description: "User provides both positive and negative feedback",
  turns: [
    { role: "user", text: "I really like the product images, they're very clear." },
    { role: "interviewer", expectedBehavior: "note_feedback" },
    { role: "user", text: "But the shipping options are confusing. I can't tell which one is faster." },
    { role: "interviewer", expectedBehavior: "note_feedback" },
    { role: "user", text: "The checkout button is nice and prominent though. That's helpful." },
    { role: "interviewer", expectedBehavior: "acknowledge_without_evaluating" },
  ],
};
