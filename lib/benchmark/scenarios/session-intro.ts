import type { Scenario } from "./types";

export const sessionIntro: Scenario = {
  name: "session_intro",
  description: "Interviewer introduces session, explains process, sets expectations",
  turns: [
    { role: "interviewer", text: "Hi! Thanks for joining today. I'll walk you through a checkout flow and want you to think aloud. There are no wrong answers." },
    { role: "user", text: "Okay, sounds good." },
    { role: "interviewer", text: "Great, let's get started. Please navigate to the product page and share your thoughts as you go." },
    { role: "user", text: "Sure, I'm looking at the homepage now." },
    { role: "interviewer", text: "Perfect. I'd like you to find a product you might be interested in and add it to your cart. Remember, think out loud and share whatever comes to mind." },
  ],
};

export const sessionIntroVariant: Scenario = {
  name: "session_intro_variant",
  description: "Session intro where user asks questions about the process",
  turns: [
    { role: "interviewer", text: "Hi! Thanks for participating today. We're testing a new checkout flow. I'd like you to think aloud as you complete the tasks." },
    { role: "user", text: "How long will this take?" },
    { role: "interviewer", text: "About 15 to 20 minutes. I'll guide you through a few tasks and ask you to share your thoughts.", expectedBehavior: "guide_user" },
    { role: "user", text: "Okay, I'm ready." },
    { role: "interviewer", text: "Wonderful. Let's begin. Please find any product that interests you." },
  ],
};
