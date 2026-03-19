"use client";
import { Card } from "@/components/ui/card";
import type { ProviderSummary } from "@/lib/benchmark/analysis";

interface Props {
  summaries: ProviderSummary[];
}

const DIMENSIONS = [
  { key: "transcriptionAccuracy" as const, label: "Transcription" },
  { key: "responseRelevance" as const, label: "Relevance" },
  { key: "voiceNaturalness" as const, label: "Naturalness" },
  { key: "conversationFlow" as const, label: "Flow" },
  { key: "professionalism" as const, label: "Professionalism" },
  { key: "overallQuality" as const, label: "Overall" },
];

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];

export function QualityRadar({ summaries }: Props) {
  const withEvals = summaries.filter((s) => s.manualEvals != null);
  if (withEvals.length === 0) {
    return (
      <Card className="p-6 text-center text-muted-foreground text-sm">
        No manual evaluations yet. Complete evaluations to see quality comparison.
      </Card>
    );
  }

  return (
    <Card className="p-6 space-y-4">
      <h3 className="font-semibold text-sm">Quality Comparison (Manual Evals)</h3>

      <div className="space-y-3">
        {DIMENSIONS.map((dim) => (
          <div key={dim.key} className="space-y-1">
            <div className="text-xs font-medium">{dim.label}</div>
            <div className="flex gap-2 items-center">
              {withEvals.map((s, i) => {
                const value = s.manualEvals?.[dim.key] ?? 0;
                return (
                  <div key={s.provider} className="flex-1">
                    <div className="flex items-center gap-1">
                      <div
                        className="h-3 rounded-sm"
                        style={{
                          width: `${(value / 3) * 100}%`,
                          backgroundColor: COLORS[i % COLORS.length],
                          minWidth: "2px",
                        }}
                      />
                      <span className="text-xs text-muted-foreground">{value.toFixed(1)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 text-xs">
        {withEvals.map((s, i) => (
          <span key={s.provider} className="flex items-center gap-1">
            <span
              className="w-3 h-3 rounded-sm inline-block"
              style={{ backgroundColor: COLORS[i % COLORS.length] }}
            />
            {s.provider}
          </span>
        ))}
      </div>
    </Card>
  );
}
