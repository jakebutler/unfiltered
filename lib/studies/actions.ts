"use server";

/**
 * Server Actions for the Studies CRUD surface.
 *
 * Phase 1.1 scope: list, create, get. Update + archive land in 1.2 once
 * we have the guide creator wiring real status transitions.
 *
 * All actions enforce workspace scoping: every read/write is filtered
 * by `requireSession().workspace.id`. Studies that don't belong to the
 * caller's workspace are invisible.
 */

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { schema } from "@/db";
import { requireSession } from "@/lib/auth/session";
import { getDatabase } from "@/lib/cloudflare";

export type Study = typeof schema.studies.$inferSelect;

export async function listStudies(): Promise<Study[]> {
  const { workspace } = await requireSession();
  const db = getDatabase();
  return db.query.studies.findMany({
    where: eq(schema.studies.workspaceId, workspace.id),
    orderBy: [desc(schema.studies.createdAt)],
  });
}

export async function getStudy(id: string): Promise<Study | null> {
  const { workspace } = await requireSession();
  const db = getDatabase();
  const row = await db.query.studies.findFirst({
    where: and(
      eq(schema.studies.id, id),
      eq(schema.studies.workspaceId, workspace.id),
    ),
  });
  return row ?? null;
}

const CreateStudyInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  description: z.string().trim().max(2000).optional().nullable(),
  studyType: z.enum(["usability", "discovery"]).default("usability"),
  targetUrl: z
    .string()
    .trim()
    .url("Must be a valid URL")
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : null)),
});

export interface CreateStudyResult {
  ok: boolean;
  errors?: Record<string, string[]>;
  formError?: string;
  studyId?: string;
}

export async function createStudyAction(
  _prev: CreateStudyResult | null,
  formData: FormData,
): Promise<CreateStudyResult> {
  const { workspace, user } = await requireSession();

  const parsed = CreateStudyInput.safeParse({
    name: formData.get("name") ?? "",
    description: formData.get("description") ?? "",
    studyType: formData.get("studyType") ?? "usability",
    targetUrl: formData.get("targetUrl") ?? "",
  });

  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.flatten().fieldErrors,
    };
  }

  const id = crypto.randomUUID();
  const db = getDatabase();

  try {
    await db.insert(schema.studies).values({
      id,
      workspaceId: workspace.id,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      studyType: parsed.data.studyType,
      targetUrl: parsed.data.targetUrl,
      createdBy: user.id,
      status: "draft",
    });
  } catch (err) {
    console.error("createStudyAction insert failed", err);
    return {
      ok: false,
      formError: "Failed to create study. Please try again.",
    };
  }

  revalidatePath("/studies");
  redirect(`/studies/${id}`);
}
