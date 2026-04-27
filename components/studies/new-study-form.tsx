"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  createStudyAction,
  type CreateStudyResult,
} from "@/lib/studies/actions";

const STUDY_TYPES: Array<{
  value: "usability" | "discovery";
  label: string;
  description: string;
}> = [
  {
    value: "usability",
    label: "Usability",
    description:
      "Watch users interact with a live URL or prototype and surface friction.",
  },
  {
    value: "discovery",
    label: "Discovery",
    description:
      "Voice-only conversations to understand jobs, attitudes, or unmet needs.",
  },
];

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Creating..." : "Create study"}
    </Button>
  );
}

export function NewStudyForm() {
  const [state, formAction] = useActionState<CreateStudyResult | null, FormData>(
    createStudyAction,
    null,
  );
  const errors = state?.errors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Study name</Label>
        <Input
          id="name"
          name="name"
          placeholder="e.g. Onboarding flow audit"
          required
          maxLength={120}
        />
        {errors.name?.[0] ? (
          <p className="text-xs text-destructive">{errors.name[0]}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="description">Description (optional)</Label>
        <Textarea
          id="description"
          name="description"
          placeholder="What problem are you investigating? Any hypotheses going in?"
          rows={3}
          maxLength={2000}
        />
        {errors.description?.[0] ? (
          <p className="text-xs text-destructive">{errors.description[0]}</p>
        ) : null}
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">Study type</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {STUDY_TYPES.map((t, idx) => (
            <label
              key={t.value}
              className="flex cursor-pointer flex-col gap-1 rounded-md border p-4 transition-colors has-[:checked]:border-foreground has-[:checked]:bg-muted/40"
            >
              <input
                type="radio"
                name="studyType"
                value={t.value}
                defaultChecked={idx === 0}
                className="sr-only"
              />
              <span className="text-sm font-medium">{t.label}</span>
              <span className="text-xs text-muted-foreground">
                {t.description}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <Label htmlFor="targetUrl">Target URL (optional)</Label>
        <Input
          id="targetUrl"
          name="targetUrl"
          type="url"
          placeholder="https://yourapp.com/checkout"
        />
        <p className="text-xs text-muted-foreground">
          Required for usability studies before you can run sessions. You can
          add it later.
        </p>
        {errors.targetUrl?.[0] ? (
          <p className="text-xs text-destructive">{errors.targetUrl[0]}</p>
        ) : null}
      </div>

      {state?.formError ? (
        <p className="text-sm text-destructive">{state.formError}</p>
      ) : null}

      <div className="flex justify-end">
        <SubmitButton />
      </div>
    </form>
  );
}
