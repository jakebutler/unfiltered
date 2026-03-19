"use client";
import { Card } from "@/components/ui/card";
import type { ProviderSummary } from "@/lib/benchmark/analysis";

interface Props {
  summaries: ProviderSummary[];
}

export function LatencyChart({ summaries }: Props) {
  if (summaries.length === 0) return null;

  const maxLatency = Math.max(
    ...summaries.map((s) => Math.max(s.latency.ttft.mean, s.latency.total.mean)),
    1,
  );

  return (
    <Card className="p-6 space-y-4">
      <h3 className="font-semibold text-sm">Latency Comparison</h3>

      <div className="space-y-3">
        {summaries.map((s) => (
          <div key={s.provider} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">{s.provider}</span>
              <span className="text-muted-foreground">
                TTFT: {s.latency.ttft.mean.toFixed(0)}ms | Total: {s.latency.total.mean.toFixed(0)}ms
              </span>
            </div>
            <div className="flex gap-1 h-4">
              <div
                className="bg-blue-500 rounded-sm"
                style={{ width: `${(s.latency.ttft.mean / maxLatency) * 100}%` }}
                title={`TTFT: ${s.latency.ttft.mean.toFixed(0)}ms`}
              />
              <div
                className="bg-blue-300 rounded-sm"
                style={{ width: `${((s.latency.total.mean - s.latency.ttft.mean) / maxLatency) * 100}%` }}
                title={`Remaining: ${(s.latency.total.mean - s.latency.ttft.mean).toFixed(0)}ms`}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 bg-blue-500 rounded-sm inline-block" /> TTFT
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 bg-blue-300 rounded-sm inline-block" /> Remaining
        </span>
        <span className="ml-auto">
          Threshold: <span className="border-l-2 border-red-500 pl-1">500ms</span>
        </span>
      </div>
    </Card>
  );
}
