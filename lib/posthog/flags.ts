interface PostHogCapturePayload {
  event: string;
  distinct_id: string;
  properties?: Record<string, unknown>;
}

function getPostHogHost(): string {
  return process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";
}

function getPostHogApiKey(): string | undefined {
  return process.env.POSTHOG_PROJECT_API_KEY
    ?? process.env.NEXT_PUBLIC_POSTHOG_KEY
    ?? process.env.POSTHOG_API_KEY;
}

export function isPostHogConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const apiKey = env.POSTHOG_PROJECT_API_KEY ?? env.NEXT_PUBLIC_POSTHOG_KEY ?? env.POSTHOG_API_KEY;
  return Boolean(apiKey);
}

export async function capturePostHogEvent(payload: PostHogCapturePayload): Promise<{ ok: true } | { ok: false; error: string }> {
  const apiKey = getPostHogApiKey();
  if (!apiKey) {
    return { ok: false, error: "PostHog API key not configured" };
  }

  const body = {
    api_key: apiKey,
    event: payload.event,
    distinct_id: payload.distinct_id,
    properties: payload.properties ?? {},
  };

  try {
    const response = await fetch(`${getPostHogHost()}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `PostHog capture failed (${response.status}): ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown PostHog error";
    return { ok: false, error: message };
  }
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

