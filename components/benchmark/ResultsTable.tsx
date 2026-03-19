"use client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ProviderSummary } from "@/lib/benchmark/analysis";

interface Props {
  summaries: ProviderSummary[];
}

function formatMs(val: number | null | undefined): string {
  if (val == null || val === 0) return "N/A";
  return `${val.toFixed(0)}ms`;
}

function formatPercent(val: number | null | undefined): string {
  if (val == null) return "N/A";
  return `${(val * 100).toFixed(1)}%`;
}

function formatCost(val: number | null | undefined): string {
  if (val == null || val === 0) return "N/A";
  return `$${val.toFixed(4)}`;
}

function latencyBadge(ms: number): "default" | "secondary" | "destructive" {
  if (ms <= 300) return "default";
  if (ms <= 500) return "secondary";
  return "destructive";
}

export function ResultsTable({ summaries }: Props) {
  if (summaries.length === 0) {
    return <Card className="p-6 text-center text-muted-foreground text-sm">No results yet</Card>;
  }

  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b">
            <th className="text-left p-3 font-medium">Provider</th>
            <th className="text-right p-3 font-medium">Sessions</th>
            <th className="text-right p-3 font-medium">Avg TTFT</th>
            <th className="text-right p-3 font-medium">Median TTFT</th>
            <th className="text-right p-3 font-medium">P95 TTFT</th>
            <th className="text-right p-3 font-medium">Avg Total</th>
            <th className="text-right p-3 font-medium">WER</th>
            <th className="text-right p-3 font-medium">Cost/min</th>
          </tr>
        </thead>
        <tbody>
          {summaries.map((s) => (
            <tr key={s.provider} className="border-b last:border-0">
              <td className="p-3 font-medium">{s.provider}</td>
              <td className="p-3 text-right">
                {s.successfulSessions}/{s.totalSessions}
                {s.failedSessions > 0 && (
                  <Badge variant="destructive" className="ml-1 text-xs">{s.failedSessions} failed</Badge>
                )}
              </td>
              <td className="p-3 text-right">
                <Badge variant={latencyBadge(s.latency.ttft.mean)}>{formatMs(s.latency.ttft.mean)}</Badge>
              </td>
              <td className="p-3 text-right">{formatMs(s.latency.ttft.median)}</td>
              <td className="p-3 text-right">{formatMs(s.latency.ttft.p95)}</td>
              <td className="p-3 text-right">{formatMs(s.latency.total.mean)}</td>
              <td className="p-3 text-right">{formatPercent(s.avgWer)}</td>
              <td className="p-3 text-right">{formatCost(s.avgCostPerMinute)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
