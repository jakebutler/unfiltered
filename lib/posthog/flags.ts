export interface PostHogCapturePayload {
  event: string;
  distinct_id: string;
  properties?: Record<string, unknown>;
}

export interface PostHogConfig {
  host: string;
  apiKey: string;
}

export function getPostHogConfig(env: Record<string, string | undefined> = process.env): PostHogConfig | null {
  const apiKey = env.POSTHOG_PROJECT_API_KEY
    ?? env.NEXT_PUBLIC_POSTHOG_KEY
    ?? env.POSTHOG_API_KEY;
  if (!apiKey) return null;
  return {
    host: env.POSTHOG_HOST ?? "https://us.i.posthog.com",
    apiKey,
  };
}

export function isPostHogConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(getPostHogConfig(env));
}

export function buildPostHogCaptureBody(payload: PostHogCapturePayload, apiKey: string): Record<string, unknown> {
  return {
    api_key: apiKey,
    event: payload.event,
    distinct_id: payload.distinct_id,
    properties: payload.properties ?? {},
  };
}

export function buildExperimentProperties(input: {
  experimentId: string;
  runId: string;
  variationIndex: number;
  studyId: string;
  assignedEngineVariant: string;
}): Record<string, unknown> {
  return {
    experiment_id: input.experimentId,
    run_id: input.runId,
    variation_index: input.variationIndex,
    study_id: input.studyId,
    assigned_engine_variant: input.assignedEngineVariant,
    is_structured_experiment: true,
  };
}
