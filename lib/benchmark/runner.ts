import type { VoiceProvider, SessionConfig, SessionResult, TurnMetrics, ProviderType } from "@/lib/voice/types";
import { createProvider } from "@/lib/voice/provider-registry";
import { calculateWer, computeTurnLatencies, aggregateSessionMetrics } from "@/lib/voice/metrics";
import { getScenarioByName } from "./scenarios";
import type { Scenario, ScenarioTurn } from "./scenarios/types";

const UX_RESEARCH_SYSTEM_PROMPT = `You are a UX research interviewer conducting a usability session.
Your role is to guide participants through tasks, ask clarifying questions,
and gather feedback without leading the user. Be professional, friendly,
and neutral in your responses.

Key guidelines:
- Never lead the user or suggest answers
- Use neutral language
- Acknowledge user feedback without evaluating it
- Restate and confirm important feedback
- Guide users through tasks without instructing them how to complete them
- Handle silence gracefully
- Be patient with confused users`;

export interface RunConfig {
  providers: ProviderType[];
  scenarios: string[];
  repetitions: number;
  providerConfigs?: Record<string, Record<string, unknown>>;
}

export interface RunProgress {
  total: number;
  completed: number;
  current: {
    provider: string;
    scenario: string;
    repetition: number;
  } | null;
  results: SessionResult[];
  errors: Array<{ provider: string; scenario: string; error: string }>;
}

export type ProgressCallback = (progress: RunProgress) => void;

export async function runSingleSession(
  providerType: ProviderType,
  scenarioName: string,
  providerConfig?: Record<string, unknown>,
): Promise<SessionResult> {
  const scenario = getScenarioByName(scenarioName);
  if (!scenario) throw new Error(`Scenario "${scenarioName}" not found`);

  const sessionId = `${providerType}_${scenarioName}_${Date.now()}`;
  const config: SessionConfig = {
    scenarioName,
    provider: providerType,
    systemPrompt: UX_RESEARCH_SYSTEM_PROMPT,
    language: "en",
    sampleRate: 16000,
    noiseLevel: getScenarioNoiseLevel(scenario),
  };

  const result: SessionResult = {
    sessionId,
    config,
    provider: providerType,
    startedAt: Date.now(),
    turns: [],
    inputTokens: 0,
    outputTokens: 0,
    audioDurationSeconds: 0,
    estimatedCostUsd: 0,
    errors: [],
    success: true,
  };

  let provider: VoiceProvider | null = null;

  try {
    provider = createProvider(providerType, providerConfig ?? {});

    const errors = provider.validateConfig();
    if (errors.length > 0) {
      throw new Error(`Provider config errors: ${errors.join(", ")}`);
    }

    await provider.connect(config);

    for (let i = 0; i < scenario.turns.length; i++) {
      const turn = scenario.turns[i];
      const turnMetrics = await executeTurn(provider, turn, i, scenario);
      result.turns.push(turnMetrics);
    }

    aggregateSessionMetrics(result);
    result.estimatedCostUsd = provider.calculateCost(result);
  } catch (e) {
    result.success = false;
    result.errors.push({
      type: (e as Error).constructor.name,
      message: (e as Error).message,
      timestamp: new Date().toISOString(),
    });
  } finally {
    if (provider) await provider.disconnect();
  }

  result.endedAt = Date.now();
  if (result.startedAt && result.endedAt) {
    result.totalDurationMs = result.endedAt - result.startedAt;
  }

  return result;
}

async function executeTurn(
  provider: VoiceProvider,
  turn: ScenarioTurn,
  turnIndex: number,
  _scenario: Scenario,
): Promise<TurnMetrics> {
  const metrics: TurnMetrics = {
    turnIndex,
    role: turn.role,
    transcriptionText: "",
    responseText: "",
    referenceText: turn.text ?? "",
  };

  if (turn.role === "user" && turn.text) {
    // Simulate silence if specified
    if (turn.silenceDurationSeconds) {
      await delay(turn.silenceDurationSeconds * 1000);
    }

    // Send user text (in a real implementation, this would be audio)
    metrics.audioSentAt = Date.now();
    await provider.sendText(turn.text);

    // Collect response
    for await (const event of provider.receiveResponse()) {
      switch (event.type) {
        case "transcript":
          metrics.transcriptionReceivedAt = event.timestampMs;
          metrics.transcriptionText = event.content as string;
          break;
        case "first_token":
          metrics.llmResponseAt = event.timestampMs;
          break;
        case "text":
          metrics.responseText += event.content as string;
          if (!metrics.llmResponseAt) metrics.llmResponseAt = event.timestampMs;
          break;
        case "audio":
          if (!metrics.audioReceivedAt) metrics.audioReceivedAt = event.timestampMs;
          break;
        case "response_complete":
        case "session_end":
          break;
        case "error":
          break;
      }
    }

    // Calculate latencies
    computeTurnLatencies(metrics);

    // Calculate WER if we have both reference and transcription
    if (metrics.referenceText && metrics.transcriptionText) {
      metrics.wer = calculateWer(metrics.referenceText, metrics.transcriptionText);
    }
  }

  return metrics;
}

function getScenarioNoiseLevel(scenario: Scenario): number | null {
  for (const turn of scenario.turns) {
    if (turn.snrDb != null) return turn.snrDb;
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBenchmark(
  runConfig: RunConfig,
  onProgress?: ProgressCallback,
): Promise<SessionResult[]> {
  const total = runConfig.providers.length * runConfig.scenarios.length * runConfig.repetitions;
  const results: SessionResult[] = [];
  const errors: Array<{ provider: string; scenario: string; error: string }> = [];
  let completed = 0;

  for (const providerType of runConfig.providers) {
    for (const scenarioName of runConfig.scenarios) {
      for (let rep = 0; rep < runConfig.repetitions; rep++) {
        onProgress?.({
          total,
          completed,
          current: { provider: providerType, scenario: scenarioName, repetition: rep + 1 },
          results,
          errors,
        });

        try {
          const result = await runSingleSession(
            providerType,
            scenarioName,
            runConfig.providerConfigs?.[providerType],
          );
          results.push(result);
        } catch (e) {
          errors.push({
            provider: providerType,
            scenario: scenarioName,
            error: (e as Error).message,
          });
        }

        completed++;
      }
    }
  }

  onProgress?.({
    total,
    completed,
    current: null,
    results,
    errors,
  });

  return results;
}
