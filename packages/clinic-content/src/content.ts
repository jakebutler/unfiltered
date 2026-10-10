// Exact text transcribed from CC-0.2 and its targeted PHQ-4 approval addendum.
// Wording status is separate from implementation and real-clinic protocol approval.
export const documentProvenance = {
  "version": "CC-0.2",
  "sourcePath": "docs/rebuild/design/CLINICAL-CONTENT.md",
  "reviewedBodySha256": "272fc43512dfa9faefdea861b997caca9a17b27fd6f39237f5dff060018df6c4",
  "targetedApprovalAddendumDate": "2026-10-09",
  "requirementApproval": "accepted-user-direction",
  "detailApproval": "proposed",
  "clinicalProtocolApproval": false
} as const;
export const topicText = [
  {
    "id": "Q01",
    "presentation": "R",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q01",
    "purpose": "Patient-defined priorities; D, S1",
    "branchAndClarification": "Clarify one priority if several compete. Accept non-weight goals; do not demand a target weight.",
    "workAccountability": "M + RD",
    "minimumDetailText": "Main reason for seeking care; one personally meaningful outcome or priority."
  },
  {
    "id": "Q02",
    "presentation": "R",
    "wordingVersion": 2,
    "wordingStatus": "proposed-detail",
    "openingPromptId": "Q02",
    "purpose": "Surface specific current concerns without diagnosing; Jake direction, D",
    "branchAndClarification": "B01 and the Q02 targets clarify a positive response. E-policy interrupts immediately when applicable; no universal diagnostic checklist.",
    "workAccountability": "M",
    "minimumDetailText": "Explicit no current concern, or the symptom in the patient's words, onset/timecourse, present impact and help sought. No diagnostic detail threshold."
  },
  {
    "id": "Q03",
    "presentation": "R",
    "wordingVersion": 2,
    "wordingStatus": "proposed-detail",
    "openingPromptId": "Q03",
    "purpose": "Life-stage trajectory; Jake direction, S1",
    "branchAndClarification": "Continue only through the missing windows Q03a–e below: childhood, teens, after high school, last five years, past 18 months. Approximate descriptions suffice; no required childhood numbers.",
    "workAccountability": "M + RD",
    "minimumDetailText": "A trajectory description for each applicable life-stage window, plus timing/context of major changes. Numeric weights only if remembered. For a young adult, five-year/18-month windows overlap earlier life stages; do not force nonexistent separate adulthood."
  },
  {
    "id": "Q04",
    "presentation": "R-value",
    "wordingVersion": 2,
    "wordingStatus": "proposed-detail",
    "openingPromptId": "Q04",
    "purpose": "Required measurements with provenance; Jake direction, S3",
    "branchAndClarification": "Follow with Q04a–c below for last actual weight/date and current estimate when indicated. Missing/refused data prevents complete intake but never prevents partial save/handoff. No BMI eligibility decision.",
    "workAccountability": "M + RD",
    "minimumDetailText": "Height value+units; latest actual weight value+units and date/approximate period; whether that reading represents now; separate current estimate+units if it no longer does and an estimate is available."
  },
  {
    "id": "Q05",
    "presentation": "R",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q05",
    "purpose": "Prior experience and patient burden; S1, D",
    "branchAndClarification": "Clarify a named treatment, timeframe, or concern; current medicine moves to Q08 without repetition.",
    "workAccountability": "M + RD",
    "minimumDetailText": "Explicit none, or named/type of approach, approximate period/duration, what happened/helped and problems/reason stopped if stopped. Reuse drug/procedure facts."
  },
  {
    "id": "Q06",
    "presentation": "R",
    "wordingVersion": 2,
    "wordingStatus": "proposed-detail",
    "openingPromptId": "Q06",
    "purpose": "Explicit patient-reported comorbidity history; Jake direction, S3, S12",
    "branchAndClarification": "Q06a–d check common groups not already answered; known/uncertain conditions use bounded branches below. Never presume diagnosis from weight, medication or an unchecked item.",
    "workAccountability": "M + RD",
    "minimumDetailText": "Explicit state for the common groups checked below; for each reported condition, patient term, current care/treatment and concern or no current concern. Diabetes uses the focused bundle below."
  },
  {
    "id": "Q07",
    "presentation": "R",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q07",
    "purpose": "Relevant care history; S1, D",
    "branchAndClarification": "If yes, use the Q07 minimum targets and shared follow-up/stop rule. Patient need not decide medical relevance; preserve volunteered history.",
    "workAccountability": "M; RD for relevant nutrition context",
    "minimumDetailText": "Explicit none, or procedure/reason for admission, approximate date and continuing effects/follow-up relevant to daily care."
  },
  {
    "id": "Q08",
    "presentation": "R",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q08",
    "purpose": "Medication and supplement context; S4",
    "branchAndClarification": "B02 for unclear details or refill; no guessed drug, formulation, route, amount, or frequency. No inferred nonadherence.",
    "workAccountability": "M",
    "minimumDetailText": "Explicit none, or each known name, strength/amount+units, actual schedule/use, reason if known, and uncertainty/access concerns. Label directions and actual use remain separate."
  },
  {
    "id": "Q09",
    "presentation": "R",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q09",
    "purpose": "Reaction history; S4",
    "branchAndClarification": "Clarify substance and patient-described reaction; uncertain allergy versus side effect remains uncertain. Current breathing/facial swelling concerns invoke E-policy.",
    "workAccountability": "M; RD for food-related context",
    "minimumDetailText": "Explicit none known, or substance, reaction description and approximate timing/current versus historical."
  },
  {
    "id": "Q10",
    "presentation": "O",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q10",
    "purpose": "Family context without a broad mandatory checklist; S4",
    "branchAndClarification": "Clarify relationship or condition if volunteered. Do not treat “thyroid trouble” as medullary thyroid cancer or a medication contraindication.",
    "workAccountability": "M",
    "minimumDetailText": "If offered: known condition and relationship, or explicit none known. Unknown subtype stays unknown."
  },
  {
    "id": "Q11",
    "presentation": "R",
    "wordingVersion": 2,
    "wordingStatus": "proposed-detail",
    "openingPromptId": "Q11",
    "purpose": "Concrete diet recall and usual pattern; Jake direction, S1/S2",
    "branchAndClarification": "Q11a–e fill missing occasions, drinks, approximate amounts, context and typicality. No calorie prescription or moral labels; refusal and eating-concern rules still apply.",
    "workAccountability": "RD; M for concerns",
    "minimumDetailText": "One identified day's eating occasions including omitted meals, approximate times, foods/drinks and ordinary household amounts if recalled; snacks/overnight intake; whether representative and usual differences."
  },
  {
    "id": "Q12",
    "presentation": "R",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q12",
    "purpose": "Offer sensitive concerns without diagnosis; S5",
    "branchAndClarification": "Offer discussion/decline without requiring details. Volunteered concern invokes E05; do not ask for weight-loss tactics, amounts, or a diagnostic score.",
    "workAccountability": "M + RD",
    "minimumDetailText": "Explicit no concern, or concern type, current versus past, effect on wellbeing and requested support to the extent willingly shared. A private-discussion choice meets presentation, stops probing and leaves the information target unresolved for staff."
  },
  {
    "id": "Q13",
    "presentation": "R",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q13",
    "purpose": "Feasibility and food access; S2",
    "branchAndClarification": "Clarify help requested; no income, benefits, or documentation requirement. Reported inability to eat due to illness also goes to M.",
    "workAccountability": "RD; A for requested logistics",
    "minimumDetailText": "Barrier present/absent; practical effect and help requested when present."
  },
  {
    "id": "Q14",
    "presentation": "R",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q14",
    "purpose": "Function and patient preferences; S1, S2",
    "branchAndClarification": "Clarify ordinary limitations versus a new/current symptom if needed; acute concern invokes E-policy. No exercise prescription or able-bodied assumption.",
    "workAccountability": "RD + M as relevant",
    "minimumDetailText": "Usual activity/movement type and approximate frequency; everyday functional limits or explicit none; patient preference."
  },
  {
    "id": "Q15",
    "presentation": "R",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q15",
    "purpose": "Sleep context; S1, S2",
    "branchAndClarification": "Clarify pattern or a patient-reported diagnosis/treatment. Snoring does not become an apnea diagnosis.",
    "workAccountability": "M + RD",
    "minimumDetailText": "Usual schedule/approximate duration, quality/daytime effect, known sleep condition and treatment or none."
  },
  {
    "id": "Q16",
    "presentation": "R",
    "wordingVersion": 2,
    "wordingStatus": "proposed-detail",
    "openingPromptId": "Q16",
    "purpose": "Explicit mental/behavioral-health check; Jake direction, S1/S2; recommended S15 instrument below",
    "branchAndClarification": "Collect distinct history/current-care answers, offer the exact PHQ-4 block, then stress/context/support. No diagnosis; spontaneous distress invokes E04 regardless of score.",
    "workAccountability": "M; RD reviews full context",
    "minimumDetailText": "Distinct depression/anxiety history/current-care status; four two-week frequency responses if PHQ-4 adopted; current stress/daily impact and desired support. Declines remain visible and unscored."
  },
  {
    "id": "Q17",
    "presentation": "O",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q17",
    "purpose": "Open medical context; original D prompt",
    "branchAndClarification": "If offered, use the Q17 minimum targets and shared follow-up/stop rule. No mandatory disclosure, moral judgment, detox advice, or inferred disorder.",
    "workAccountability": "M",
    "minimumDetailText": "If offered: which substances or explicit none, approximate usual frequency/amount in patient's units and any concern/help requested."
  },
  {
    "id": "Q18",
    "presentation": "C",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q18",
    "purpose": "Reproductive context can matter to medication review; S4",
    "branchAndClarification": "Offer when weight-management medication is being discussed/reported, or the patient raises reproductive context. Never infer relevance from sex/name/voice. Unknown, not applicable, or private discussion accepted. No contraception/pregnancy-test checklist or autonomous medication direction.",
    "workAccountability": "M",
    "minimumDetailText": "When triggered: relevance/status or explicit not applicable; current/planned pregnancy/breastfeeding concern or private-discussion choice."
  },
  {
    "id": "Q19",
    "presentation": "R",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q19",
    "purpose": "Care coordination; D",
    "branchAndClarification": "Names/roles and record description only if known. No assumption of consent to contact or that records/labs have been received.",
    "workAccountability": "M; A for record coordination",
    "minimumDetailText": "Current clinicians/roles or none; relevant record/test description, approximate date and known availability or explicit none."
  },
  {
    "id": "Q20",
    "presentation": "R",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q20",
    "purpose": "Access barriers; S2, D",
    "branchAndClarification": "Clarify requested help, not personal financial details. Create A work only when there is an actionable request.",
    "workAccountability": "A; relevant M/RD context",
    "minimumDetailText": "Main logistics/access barriers or explicit none; impact on care and requested help if any."
  },
  {
    "id": "Q21",
    "presentation": "O",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q21",
    "purpose": "Respectful participation; D",
    "branchAndClarification": "Do not re-ask entry preferences. Preserve original wording; unsupported language needs staff help, not an unverified clinical translation.",
    "workAccountability": "Relevant care team; A for support",
    "minimumDetailText": "If offered: name/address preference, language and accessibility/communication need or no additional support; relevant existing preferences reused."
  },
  {
    "id": "Q22",
    "presentation": "R",
    "wordingVersion": 1,
    "wordingStatus": "retained-approved-plan",
    "openingPromptId": "Q22",
    "purpose": "Patient agenda and omissions; D",
    "branchAndClarification": "Classify each concern by requested work; do not promise an answer or action. Review follows, not another broad interview.",
    "workAccountability": "Owner(s) by concern",
    "minimumDetailText": "Specific remaining question/request with intended owner or explicit no further item."
  }
] as const;
export const promptText = [
  {
    "id": "Q01",
    "text": "What would you most like help with, and what would meaningful progress look like for you?",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q01.followup.1",
    "text": "What would you most like to be different in daily life?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q01.followup.2",
    "text": "Which of those matters most to you right now?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q02",
    "text": "Are there any specific symptoms or health concerns you want your care team to know about now?",
    "origin": "opening",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q02.followup.1",
    "text": "What does [patient's term] feel like for you?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q02.followup.2",
    "text": "About when did it start?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q02.followup.3",
    "text": "Is it happening now, and how is it affecting you?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q03",
    "text": "Let's walk through how your weight has changed over time. What was your experience with weight as a child?",
    "origin": "opening",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q03.followup.1",
    "text": "You mentioned the gain after school; was your weight fairly steady before then, or changing?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q04",
    "text": "What is your height, including the units?",
    "origin": "opening",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q04.followup.1",
    "text": "Was that a measured reading or your estimate?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q04.followup.2",
    "text": "Which units were those?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q05",
    "text": "What approaches to weight or health have you tried, including nutrition support, programs, medicines, or procedures? What helped or was difficult?",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q05.followup.1",
    "text": "About when did you try it, and for how long?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q05.followup.2",
    "text": "What helped, and what led you to stop or change it?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q06",
    "text": "What health conditions have you been told you have? I'll also check a few common conditions so we don't miss something that could matter to your care.",
    "origin": "opening",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q06.followup.1",
    "text": "What have you been told about that condition?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q06.followup.2",
    "text": "Who helps you manage it?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q06.followup.3",
    "text": "Is there anything about it troubling you now?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q07",
    "text": "Have you had surgery, a weight-related procedure, or a hospital stay that you want the team to know about?",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q07.followup.1",
    "text": "What was the procedure or hospital stay for, and roughly when was it?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q07.followup.2",
    "text": "Has it changed how you eat, take medicines, or manage daily activities?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q08",
    "text": "What medicines, vitamins, supplements, or weight-loss products do you currently use, if any? Share the names and how you take them as best you know.",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q08.followup.1",
    "text": "How do you actually take it, compared with those directions?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q08.followup.2",
    "text": "Is anything making it difficult to take or obtain?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q09",
    "text": "Do you have any allergies or reactions to medicines or other substances? If so, what happened?",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q09.followup.1",
    "text": "What happened when you used or encountered it?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q09.followup.2",
    "text": "Was that in the past or is it happening now?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q10",
    "text": "Is there any family health history you know about that you would like your medical clinician to consider?",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q10.followup.1",
    "text": "Which relative, and what condition were they told they had, as best you know?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q11",
    "text": "Let's walk through yesterday's eating and drinking, from when you woke up until you went to sleep. What did you first eat or drink, and about when?",
    "origin": "opening",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q12",
    "text": "Would you like to share any concerns about eating or your relationship with food, such as feeling out of control, eating much less than you need, or trying to undo eating? It's also okay to discuss this with your care team instead.",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q12.followup.1",
    "text": "Is this happening now or something you've dealt with before?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q12.followup.2",
    "text": "What support would feel useful?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q13",
    "text": "What makes getting or preparing the food you want easier or harder—for example cost, time, access, equipment, or support?",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q13.followup.1",
    "text": "When that happens, what becomes difficult about getting or preparing food?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q13.followup.2",
    "text": "What kind of help would be useful?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q14",
    "text": "What kinds of movement or activity fit your life, and are pain, breathing, mobility, fatigue, or other limits getting in the way?",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q14.followup.1",
    "text": "What does a usual week of movement look like for you?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q14.followup.2",
    "text": "Are there daily tasks you'd like to do more comfortably?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q15",
    "text": "How is your sleep, and are there sleep concerns or treatments you want the team to know about?",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q15.followup.1",
    "text": "About when do you sleep and wake, and how rested do you feel?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q15.followup.2",
    "text": "Have you been told you have a sleep condition or use treatment for one?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q16",
    "text": "We'll check both depression and anxiety, as well as stress and support. Have you ever been told you have depression or an anxiety condition, or received care for either?",
    "origin": "opening",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q16.followup.1",
    "text": "What has been putting pressure on you lately, if anything?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q16.followup.2",
    "text": "How does it affect your day, and what support do you have or want?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q17",
    "text": "Is there anything about alcohol, nicotine, cannabis, or other substance use that you want your medical clinician to know?",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q17.followup.1",
    "text": "How often would you typically use it, and roughly how much?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q17.followup.2",
    "text": "Is anything about it something you'd like help with?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q18",
    "text": "If relevant to you, is pregnancy, planning a pregnancy, or breastfeeding something you would like your medical clinician to consider? You can discuss this with them privately instead.",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q18.followup.1",
    "text": "What would you like your medical clinician to take into account?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q19",
    "text": "Who else is involved in your health care, and are there recent tests or records you would like the team to review?",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q19.followup.1",
    "text": "Which clinician or service manages that?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q19.followup.2",
    "text": "What was the test, about when was it done, and do you have the result?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q20",
    "text": "What could make visits or ongoing care difficult—for example timing, cost, internet access, privacy, work, or caregiving?",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q20.followup.1",
    "text": "What would make it easier for you to attend or keep up with care?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q20.followup.2",
    "text": "Which part would you like staff to help with?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q21",
    "text": "How would you like us to address you, and what language, communication, or accessibility support would help?",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q21.followup.1",
    "text": "What format or support works best for you?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q22",
    "text": "What else would you like the team to know, or what questions would you like them to answer?",
    "origin": "opening",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "Q22.followup.1",
    "text": "What would you like the team to do or clarify about that?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q03a",
    "text": "What was your experience with weight as a child?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q03b",
    "text": "How about during your teenage years?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q03c",
    "text": "What changed, if anything, after high school or during that stage of life?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q03d",
    "text": "What has your weight been like over the last five years?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q03e",
    "text": "And over the past 18 months—fairly steady, increasing, decreasing, or changing in another way?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q04a",
    "text": "When was the last time your weight was actually measured, and what was the reading, including the units?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q04b",
    "text": "Does that reading still reflect your weight now, or do you think it has changed?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q04c",
    "text": "If you can estimate your current weight, what would it be, including the units? We'll record it as an estimate.",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q11a",
    "text": "What did you have next, and about what time?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q11b",
    "text": "About how much did you have? An everyday description, such as a bowl, slice or cup, is fine.",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q11c",
    "text": "What did you drink with that or between eating occasions, including anything added to the drink?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q11d",
    "text": "Was there anything else between meals, in the evening, or overnight?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q11e",
    "text": "Was that a usual day for you? If not, what is usually different, including on workdays or days off?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q06a",
    "text": "Have you ever been told you have diabetes or prediabetes?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q06b",
    "text": "Have you been told you have high blood pressure, high cholesterol, heart disease, or a previous stroke?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q06c",
    "text": "Have you been told you have sleep apnea, a fatty liver or another liver condition, or kidney disease?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q06d",
    "text": "Have you been told you have arthritis or another joint condition, a thyroid or other hormone condition, or a digestive condition?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "DM01",
    "text": "What type were you told you have, and roughly when were you told?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "DM02",
    "text": "What medicines or other treatment do you use for it?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "DM03",
    "text": "Do you check your blood sugar—for example with a meter or sensor—and what is the most recent result you know, including units and when it was taken? If you know a recent A1C result, you can share that and its date too.",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "DM04",
    "text": "Have you had episodes you were told were low blood sugar, or episodes you thought might be low blood sugar? What happened, when was the most recent, and did you need someone else's help?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "DM05",
    "text": "Who currently helps you manage it, and is there a concern you want them or this care team to review?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "COND01",
    "text": "What have you been told about [patient's condition term], and what treatment or follow-up do you have for it?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "COND02",
    "text": "Is it causing any difficulties now, and who helps you manage it?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q16b",
    "text": "What support or care do you already have, and is there support you would like?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "COPY-01",
    "text": "Corvo Clinic is a fictional demo. Use the provided fictional details, not your own health information. No medical care is provided or monitored here.",
    "origin": "authority-copy",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "COPY-02",
    "text": "I can help collect your answers and questions for the care team to review. I can't diagnose you, decide whether a treatment is right for you, or prescribe medicine.",
    "origin": "authority-copy",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "COPY-03",
    "text": "You can say ‘I don't know,’ ‘I'd rather discuss this with my care team,’ or ‘Skip for now.’ You can check and change your answers before sending them.",
    "origin": "authority-copy",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "COPY-04",
    "text": "A medical clinician would need to review your situation to discuss treatment options. I can record what you want to ask.",
    "origin": "authority-copy",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "COPY-05",
    "text": "I can't tell you whether to take, skip, repeat, or change a dose. If this is a real medication question, contact your prescriber or pharmacist for advice.",
    "origin": "authority-copy",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "COPY-06",
    "text": "Please check that this reflects what you want to share, including anything marked unknown or left unanswered.",
    "origin": "authority-copy",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "COPY-07",
    "text": "Received by Corvo Clinic's demo staff workspace. [Role] review is pending. This is not a treatment decision.",
    "origin": "authority-copy",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "COPY-08",
    "text": "Delivery is not confirmed yet. Your confirmed answers are saved. Check delivery status before trying again.",
    "origin": "authority-copy",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "B01",
    "text": "What are you experiencing, when did it start, and how is it affecting what you can do?",
    "origin": "bounded-clarification",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "B02",
    "text": "If the label is available, can you share the medicine name, strength, and the directions written on it? Please don't guess anything you aren't sure about.",
    "origin": "bounded-clarification",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "B03",
    "text": "Are you unsure whether you took the dose, or do you think you may have taken an extra dose?",
    "origin": "bounded-clarification",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "B04",
    "text": "Are you having severe belly pain, trouble breathing, fainting or confusion, or are you unable to keep fluids down?",
    "origin": "bounded-clarification",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "S01",
    "text": "For your appointment on [verified date/time/timezone], what has changed since [dated prior update], and what matters most for this visit?",
    "origin": "scenario",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "S01a",
    "text": "I don't have a confirmed appointment to refer to. What update would you like to share, and what appointment details should staff check?",
    "origin": "scenario",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "S02",
    "text": "What would you like to share or get help with between visits?",
    "origin": "scenario",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "S03",
    "text": "Looking at the plan recorded by [demo author/role] on [date], what questions, changes, or difficulties would you like to share?",
    "origin": "scenario",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "S03a",
    "text": "I don't have a follow-up plan to refer to. What would you like your care team to review?",
    "origin": "scenario",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "COPY-09",
    "text": "I can show the plan that was recorded, but I can't add new treatment directions.",
    "origin": "authority-copy",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "S04",
    "text": "What bill, coverage, or payment question would you like staff to help with? Share a reference or service date if you know it, but don't enter payment-card or bank details.",
    "origin": "scenario",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "S05",
    "text": "Would you like to request a visit, change one, or cancel one? Tell us which visit if known, and any timing or accessibility preferences, including your time zone.",
    "origin": "scenario",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "S06",
    "text": "Which medicine are you asking about, how much do you have left, and which pharmacy should staff check with, if you know?",
    "origin": "scenario",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "S07",
    "text": "Have you noticed symptoms, had trouble taking it, or had any changes or questions since the last prescription?",
    "origin": "scenario",
    "wordingStatus": "retained-approved-plan"
  },
  {
    "id": "SLEEP01",
    "text": "Do you use any treatment for sleep apnea, and is anything making it difficult to use?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "GI01",
    "text": "How does this affect eating, drinking, or digestion now?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "stop-choice",
    "text": "Would you rather move on or come back to this?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q03.change-context",
    "text": "Roughly when did that change happen, and what else was happening in your life?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q11.preparation",
    "text": "How was it prepared, and where or with whom did you eat?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "Q06.uncertain",
    "text": "What were you told, as best you remember?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "MH.unscored",
    "text": "Have low mood, loss of interest, anxiety, or worry been affecting you recently? Which, if any, and how has it affected daily life?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  }
] as const;

export const supplementalPromptText = [
  {
    "id": "Q16a",
    "text": "What has been putting pressure on you lately, if anything, and how has it affected your day?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "W02.followup.1",
    "text": "What has changed about [previously reported item] since [date]?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "W02.followup.2",
    "text": "What do you most want covered at this visit?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "W03.followup.1",
    "text": "What changed, and what would you like the team to help with?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "W04.followup.1",
    "text": "Which part of the recorded plan would you like to discuss?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "W04.followup.2",
    "text": "What do you remember wanting help with, without guessing the instructions?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "W05.followup.1",
    "text": "What part of the bill or coverage information seems wrong or unclear?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "W06.followup.1",
    "text": "Which days or times could work, and what time zone should staff use?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "W07.followup.1",
    "text": "What is making the refill difficult?",
    "origin": "directed-followup",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "COPY-10",
    "text": "These four questions ask about depression and anxiety symptoms over the past two weeks. They are a screening check, not a diagnosis. You can skip an item or discuss it with your care team.",
    "origin": "instrument",
    "wordingStatus": "proposed-detail"
  },
  {
    "id": "MH.stem",
    "text": "Over the last 2 weeks, how often have you been bothered by the following problems?",
    "origin": "instrument",
    "wordingStatus": "accepted-targeted-choice"
  },
  {
    "id": "MH01",
    "text": "Feeling nervous, anxious or on edge",
    "origin": "instrument",
    "wordingStatus": "accepted-targeted-choice"
  },
  {
    "id": "MH02",
    "text": "Not being able to stop or control worrying",
    "origin": "instrument",
    "wordingStatus": "accepted-targeted-choice"
  },
  {
    "id": "MH03",
    "text": "Little interest or pleasure in doing things",
    "origin": "instrument",
    "wordingStatus": "accepted-targeted-choice"
  },
  {
    "id": "MH04",
    "text": "Feeling down, depressed, or hopeless",
    "origin": "instrument",
    "wordingStatus": "accepted-targeted-choice"
  }
] as const;
