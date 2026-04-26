import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  real,
} from "drizzle-orm/sqlite-core";

// ─────────────────────────────────────────────────────────────────────
// Tenancy
// ─────────────────────────────────────────────────────────────────────
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    workosUserId: text("workos_user_id").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    defaultWorkspaceId: text("default_workspace_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    workosIdx: uniqueIndex("users_workos_user_id_idx").on(t.workosUserId),
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
  }),
);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerId: text("owner_id").notNull(),
  billingPlan: text("billing_plan", {
    enum: ["free", "founder", "team", "enterprise"],
  })
    .notNull()
    .default("free"),
  retentionDays: integer("retention_days").notNull().default(365),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["owner", "admin", "member"] })
      .notNull()
      .default("owner"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    workspaceUserIdx: uniqueIndex("workspace_members_workspace_user_idx").on(
      t.workspaceId,
      t.userId,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────
// Studies + guides + personas
// ─────────────────────────────────────────────────────────────────────
export const studies = sqliteTable(
  "studies",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", {
      enum: ["draft", "guide_in_progress", "ready", "live", "complete", "archived"],
    })
      .notNull()
      .default("draft"),
    studyType: text("study_type", { enum: ["usability", "discovery"] })
      .notNull()
      .default("usability"),
    targetUrl: text("target_url"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    workspaceIdx: index("studies_workspace_idx").on(t.workspaceId),
  }),
);

export const guides = sqliteTable(
  "guides",
  {
    id: text("id").primaryKey(),
    studyId: text("study_id").notNull(),
    version: integer("version").notNull().default(1),
    json: text("json", { mode: "json" }).notNull(),
    humanReadable: text("human_readable"),
    finalizedAt: integer("finalized_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    studyIdx: index("guides_study_idx").on(t.studyId),
  }),
);

export const personas = sqliteTable(
  "personas",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    studyId: text("study_id"),
    name: text("name").notNull(),
    demographics: text("demographics"),
    goals: text("goals"),
    expertise: text("expertise"),
    attitudes: text("attitudes"),
    antiPatterns: text("anti_patterns"),
    source: text("source", { enum: ["ai", "founder", "library"] })
      .notNull()
      .default("ai"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    workspaceIdx: index("personas_workspace_idx").on(t.workspaceId),
    studyIdx: index("personas_study_idx").on(t.studyId),
  }),
);

// ─────────────────────────────────────────────────────────────────────
// Invitations
// ─────────────────────────────────────────────────────────────────────
export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    studyId: text("study_id").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    signedToken: text("signed_token").notNull(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    openedAt: integer("opened_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    studyIdx: index("invitations_study_idx").on(t.studyId),
    tokenIdx: uniqueIndex("invitations_token_idx").on(t.signedToken),
  }),
);

// ─────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    studyId: text("study_id").notNull(),
    invitationId: text("invitation_id"),
    personaId: text("persona_id"),
    isSynthetic: integer("is_synthetic", { mode: "boolean" })
      .notNull()
      .default(false),
    runtimeMode: text("runtime_mode", { enum: ["voice", "text"] })
      .notNull()
      .default("voice"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    status: text("status", {
      enum: ["pending", "in_progress", "complete", "abandoned", "errored"],
    })
      .notNull()
      .default("pending"),
    durableObjectId: text("durable_object_id"),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    studyIdx: index("sessions_study_idx").on(t.studyId),
    invitationIdx: index("sessions_invitation_idx").on(t.invitationId),
    statusIdx: index("sessions_status_idx").on(t.status),
  }),
);

export const recordings = sqliteTable(
  "recordings",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    kind: text("kind", { enum: ["camera", "screen", "audio"] }).notNull(),
    r2Key: text("r2_key").notNull(),
    durationSec: real("duration_sec"),
    sizeBytes: integer("size_bytes"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    sessionIdx: index("recordings_session_idx").on(t.sessionId),
  }),
);

export const transcriptChunks = sqliteTable(
  "transcript_chunks",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    speaker: text("speaker", { enum: ["bot", "participant"] }).notNull(),
    text: text("text").notNull(),
    tStart: real("t_start").notNull(),
    tEnd: real("t_end").notNull(),
    sequence: integer("sequence").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    sessionIdx: index("transcript_chunks_session_idx").on(t.sessionId),
    sessionSeqIdx: uniqueIndex("transcript_chunks_session_seq_idx").on(
      t.sessionId,
      t.sequence,
    ),
  }),
);

export const botEvents = sqliteTable(
  "bot_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    ts: real("ts").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    sessionIdx: index("bot_events_session_idx").on(t.sessionId),
    typeIdx: index("bot_events_type_idx").on(t.type),
  }),
);

// ─────────────────────────────────────────────────────────────────────
// Analysis (per session)
// ─────────────────────────────────────────────────────────────────────
export const sessionAnalyses = sqliteTable("session_analyses", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().unique(),
  status: text("status", {
    enum: ["pending", "running", "complete", "failed"],
  })
    .notNull()
    .default("pending"),
  workflowInstanceId: text("workflow_instance_id"),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  errorMsg: text("error_msg"),
  summary: text("summary"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const cameraSignals = sqliteTable(
  "camera_signals",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    t: real("t").notNull(),
    emotion: text("emotion"),
    focus: text("focus"),
    engagement: text("engagement"),
    notes: text("notes"),
  },
  (t) => ({
    sessionIdx: index("camera_signals_session_idx").on(t.sessionId),
  }),
);

export const screenSignals = sqliteTable(
  "screen_signals",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    t: real("t").notNull(),
    page: text("page"),
    action: text("action"),
    inferredEvents: text("inferred_events", { mode: "json" }),
    frictionFlags: text("friction_flags", { mode: "json" }),
  },
  (t) => ({
    sessionIdx: index("screen_signals_session_idx").on(t.sessionId),
  }),
);

export const frictionMoments = sqliteTable(
  "friction_moments",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    tStart: real("t_start").notNull(),
    tEnd: real("t_end").notNull(),
    severity: text("severity", { enum: ["low", "med", "high"] }).notNull(),
    description: text("description").notNull(),
    evidenceJson: text("evidence_json", { mode: "json" }).notNull(),
    themeIds: text("theme_ids", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    sessionIdx: index("friction_moments_session_idx").on(t.sessionId),
  }),
);

export const quotes = sqliteTable(
  "quotes",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    tStart: real("t_start").notNull(),
    tEnd: real("t_end").notNull(),
    text: text("text").notNull(),
    significance: text("significance", { enum: ["low", "med", "high"] }).notNull(),
    themeIds: text("theme_ids", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    sessionIdx: index("quotes_session_idx").on(t.sessionId),
  }),
);

// ─────────────────────────────────────────────────────────────────────
// Themes + findings (study-wide aggregates)
// ─────────────────────────────────────────────────────────────────────
export const themes = sqliteTable(
  "themes",
  {
    id: text("id").primaryKey(),
    studyId: text("study_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    evidenceCount: integer("evidence_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    studyIdx: index("themes_study_idx").on(t.studyId),
  }),
);

export const findings = sqliteTable(
  "findings",
  {
    id: text("id").primaryKey(),
    studyId: text("study_id").notNull(),
    sessionId: text("session_id"), // null = study-wide
    title: text("title").notNull(),
    description: text("description").notNull(),
    severity: text("severity", { enum: ["low", "med", "high"] }).notNull(),
    recommendation: text("recommendation"),
    evidenceJson: text("evidence_json", { mode: "json" }).notNull(),
    status: text("status", {
      enum: ["new", "reviewed", "acted", "dismissed"],
    })
      .notNull()
      .default("new"),
    shareSlug: text("share_slug"),
    shareSettings: text("share_settings", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    studyIdx: index("findings_study_idx").on(t.studyId),
    shareSlugIdx: uniqueIndex("findings_share_slug_idx").on(t.shareSlug),
  }),
);

// ─────────────────────────────────────────────────────────────────────
// Billing (Phase 3)
// ─────────────────────────────────────────────────────────────────────
export const billingEvents = sqliteTable(
  "billing_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    kind: text("kind", {
      enum: ["real_session", "synthetic_session"],
    }).notNull(),
    quantity: integer("quantity").notNull().default(1),
    ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
    stripeMeterEventId: text("stripe_meter_event_id"),
  },
  (t) => ({
    workspaceIdx: index("billing_events_workspace_idx").on(t.workspaceId),
    tsIdx: index("billing_events_ts_idx").on(t.ts),
  }),
);
