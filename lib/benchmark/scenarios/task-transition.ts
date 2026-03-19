import type { Scenario } from "./types";

export const taskTransition: Scenario = {
  name: "task_transition",
  description: "Interviewer confirms completion and moves to next task",
  turns: [
    { role: "user", text: "I think I've added everything I want to my cart." },
    { role: "interviewer", text: "Great, it looks like you've completed that step. Ready to move on to checkout?" },
    { role: "user", text: "Yes, I'm ready." },
    { role: "interviewer", text: "Perfect. Now let's go through the checkout process. Try to complete the purchase, noting any issues you encounter." },
  ],
};

export const taskTransitionUnsure: Scenario = {
  name: "task_transition_unsure",
  description: "User unsure about task completion",
  turns: [
    { role: "user", text: "I think I'm done... is there anything else I should do here?" },
    { role: "interviewer", expectedBehavior: "guide_user" },
    { role: "user", text: "Okay, I guess I'll move on." },
    { role: "interviewer", text: "Sounds good. Whenever you're ready, let's move to the next step." },
  ],
};
