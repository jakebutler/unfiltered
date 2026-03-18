import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Generate and store multiple personas
export const generateMany = mutation({
  args: {
    count: v.number(),
    distribution: v.optional(v.any()),
    examplePersona: v.optional(v.object({
      demographics: v.optional(v.object({
        age: v.optional(v.number()),
        gender: v.optional(v.union(v.literal("male"), v.literal("female"), v.literal("non-binary"))),
        occupation: v.optional(v.string()),
        education: v.optional(v.union(v.literal("high-school"), v.literal("bachelors"), v.literal("masters"), v.literal("phd"))),
        income: v.optional(v.union(v.literal("low"), v.literal("middle"), v.literal("high"))),
        techSavviness: v.optional(v.number()),
      })),
      background: v.optional(v.string()),
      intent: v.optional(v.string()),
      traits: v.optional(v.array(v.string())),
    })),
  },
  handler: async (ctx, args) => {
    const personas = [];
    const occupations = [
      "Software Engineer", "Product Manager", "Marketing Manager", "Teacher",
      "Nurse", "Accountant", "Designer", "Sales Representative", "Consultant", "Student",
    ];
    const traits = [
      "detail-oriented", "impatient", "cautious", "exploratory", "price-conscious",
      "brand-loyal", "tech-skeptical", "early-adopter", "visual-learner", "mobile-first",
    ];

    for (let i = 0; i < args.count; i++) {
      const age = Math.floor(Math.random() * 40) + 20;
      const techSavviness = Math.floor(Math.random() * 5) + 1;
      const selectedTraits = [];
      const numTraits = Math.floor(Math.random() * 3) + 1;
      const shuffledTraits = [...traits].sort(() => Math.random() - 0.5);
      for (let j = 0; j < numTraits; j++) {
        selectedTraits.push(shuffledTraits[j]);
      }

      const genderOptions = ["male", "female", "non-binary"] as const;
      const educationOptions = ["high-school", "bachelors", "masters", "phd"] as const;
      const incomeOptions = ["low", "middle", "high"] as const;

      const persona = await ctx.db.insert("personas", {
        demographics: {
          age: args.examplePersona?.demographics?.age ?? age,
          gender: args.examplePersona?.demographics?.gender ?? genderOptions[Math.floor(Math.random() * 3)],
          occupation: args.examplePersona?.demographics?.occupation ?? occupations[Math.floor(Math.random() * occupations.length)],
          education: args.examplePersona?.demographics?.education ?? educationOptions[Math.floor(Math.random() * 4)],
          income: args.examplePersona?.demographics?.income ?? incomeOptions[Math.floor(Math.random() * 3)],
          techSavviness: args.examplePersona?.demographics?.techSavviness ?? techSavviness,
        },
        background: args.examplePersona?.background ?? `${occupations[Math.floor(Math.random() * occupations.length)]} in their ${age}s. Uses technology ${techSavviness > 3 ? "confidently" : "cautiously"}.`,
        intent: args.examplePersona?.intent ?? "Complete the assigned tasks",
        traits: args.examplePersona?.traits ?? selectedTraits,
        createdAt: Date.now(),
      });
      personas.push(persona);
    }
    return personas;
  },
});

// Get a single persona
export const get = query({
  args: { personaId: v.id("personas") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.personaId);
  },
});

// List all personas
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    return await ctx.db.query("personas").order("desc").take(limit);
  },
});

// Delete a persona
export const remove = mutation({
  args: { personaId: v.id("personas") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.personaId);
  },
});
