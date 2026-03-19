import type { Scenario } from "./types";

export const restating: Scenario = {
  name: "restating",
  description: "Interviewer summarizes and confirms user feedback",
  turns: [
    { role: "user", text: "I found the navigation confusing at first, but once I figured it out, it was okay. The colors could be more distinct though." },
    { role: "interviewer", text: "So you mentioned the navigation was confusing initially, but became clearer. And you'd like more distinct colors. Did I capture that right?" },
    { role: "user", text: "Yes, exactly." },
    { role: "interviewer", expectedBehavior: "note_feedback" },
  ],
};

export const restatingComplex: Scenario = {
  name: "restating_complex",
  description: "Restating complex multi-part feedback",
  turns: [
    { role: "user", text: "So the search worked well, but the filters were hard to find. I liked the product details page, especially the reviews section. The checkout was fast but I wish I could save my cart for later." },
    { role: "interviewer", text: "Let me make sure I have that. Search was good. Filters were hard to locate. Product details and reviews were positive. Checkout was quick, but you'd like a save cart feature. Is that accurate?" },
    { role: "user", text: "Yes, that's right. Oh, and I also wanted to mention that the mobile view was a bit cramped." },
    { role: "interviewer", text: "Thanks for adding that. Anything else?" },
    { role: "user", text: "No, I think that covers my main thoughts." },
  ],
};

export const restatingCorrection: Scenario = {
  name: "restating_correction",
  description: "User corrects interviewer's restatement",
  turns: [
    { role: "user", text: "The checkout was actually fine, but the product comparison feature didn't work for me." },
    { role: "interviewer", text: "So you had issues with checkout and the comparison feature didn't work. Correct?" },
    { role: "user", text: "Actually, the checkout was fine. I meant I had no issues with checkout. It was just the comparison that didn't work." },
    { role: "interviewer", text: "Thank you for clarifying. So checkout was fine, but the product comparison feature didn't work as expected. Got it." },
  ],
};
