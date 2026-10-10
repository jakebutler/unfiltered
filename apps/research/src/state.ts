import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api";

export type Study = FunctionArgs<typeof api.research.saveStudy>["definition"];
export type Source = FunctionReturnType<
  typeof api.participant.sources
>["page"][number];
export type Participant = FunctionReturnType<typeof api.participant.resume>;
export type Answer = {
  kind: "answer";
  args: Omit<FunctionArgs<typeof api.participant.answer>, "token">;
};
export type Correction = {
  kind: "correction";
  args: Omit<FunctionArgs<typeof api.participant.correct>, "token">;
};
export type PendingSource = Answer | Correction;
export const CAPABILITY_KEY = "corvo.research.capability.v1";

export function clearSessionItem(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Losing access to browser storage cannot undo a server acknowledgement.
  }
}

export function readCapability(
  fragment: string,
  previous: string | null,
): string | null {
  // The app's accessible skip link may add #main during a normal session.
  if (fragment && fragment !== "#main") {
    const values = new URLSearchParams(fragment.slice(1));
    const token = values.get("token");
    return values.size === 1 && token && /^[a-f0-9]{64}$/.test(token)
      ? token
      : null;
  }
  return previous && /^[a-f0-9]{64}$/.test(previous) ? previous : null;
}
export function invitationUrl(origin: string, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invitation unavailable");
  return `${origin}/participate#token=${token}`;
}
export function currentSources(sources: Source[]): Source[] {
  const superseded = new Set(
    sources.map((source) => source.supersedes).filter(Boolean),
  );
  return sources.filter(
    (source) =>
      source.author === "participant" && !superseded.has(source.sourceId),
  );
}
export function sourceHistory(source: Source, sources: Source[]): Source[] {
  const result: Source[] = [];
  const seen = new Set<string>();
  let id = source.supersedes;
  while (id && !seen.has(id)) {
    seen.add(id);
    const earlier = sources.find((item) => item.sourceId === id);
    if (!earlier) break;
    result.push(earlier);
    id = earlier.supersedes;
  }
  return result;
}
export function emptyStudy(title: string): Study {
  return {
    title,
    introduction: "",
    goals: [""],
    script: [{ id: crypto.randomUUID(), question: "" }],
    prototypeUrl: null,
    repository: null,
  };
}
export function errorText(error: unknown): string {
  // ConvexErrors are deliberate API messages. Never render stack traces, query
  // arguments or transport URLs, which may contain participant capabilities.
  const data =
    error && typeof error === "object" && "data" in error ? error.data : null;
  return typeof data === "string"
    ? data
    : "We could not confirm the result. Check the latest saved state before trying again.";
}
export function isDefinitiveError(error: unknown): boolean {
  return !!error && typeof error === "object" && "data" in error;
}

export function readPending(
  key: string,
  storage: Pick<Storage, "getItem"> = sessionStorage,
): PendingSource | null {
  try {
    const candidate = JSON.parse(storage.getItem(key) ?? "null");
    const args = candidate?.args;
    if (
      !["answer", "correction"].includes(candidate?.kind) ||
      !args ||
      typeof args.requestId !== "string" ||
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0 ||
      typeof args.text !== "string" ||
      args.text.length > 8000 ||
      !args.text.trim()
    )
      return null;
    if (
      candidate.kind === "answer" &&
      typeof args.questionId === "string" &&
      args.channel === "text"
    )
      return {
        kind: "answer",
        args: {
          requestId: args.requestId,
          expectedRevision: args.expectedRevision,
          text: args.text,
          questionId: args.questionId,
          channel: "text",
        },
      };
    if (candidate.kind === "correction" && typeof args.sourceId === "string")
      return {
        kind: "correction",
        args: {
          requestId: args.requestId,
          expectedRevision: args.expectedRevision,
          text: args.text,
          sourceId: args.sourceId,
        },
      };
    return null;
  } catch {
    return null;
  }
}
