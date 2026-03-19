import type { Scenario } from "./types";

export const sessionWrapup: Scenario = {
  name: "session_wrapup",
  description: "Interviewer summarizes session and closes gracefully",
  turns: [
    { role: "user", text: "I think that's all I have to share." },
    { role: "interviewer", text: "Thanks for your time today. You mentioned the button clarity was good, and you had some confusion on the navigation. Is there anything else you'd like to share before we wrap up?" },
    { role: "user", text: "No, that covers it." },
    { role: "interviewer", text: "Wonderful, thank you so much for participating. You'll receive your compensation within 24 hours. Have a great day!" },
  ],
};

export const sessionWrapupAdditional: Scenario = {
  name: "session_wrapup_additional",
  description: "User adds feedback during wrapup",
  turns: [
    { role: "interviewer", text: "Before we end, is there anything else you'd like to mention?" },
    { role: "user", text: "Actually, I just remembered - the font size was a bit small on some pages." },
    { role: "interviewer", text: "Thanks for adding that. I've noted the font size concern. Any other thoughts?" },
    { role: "user", text: "No, that's everything." },
    { role: "interviewer", text: "Perfect, thanks again for your time. Your feedback has been really helpful. Take care!" },
  ],
};
