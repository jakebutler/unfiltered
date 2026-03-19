"use client";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import type { RunProgress as RunProgressData } from "@/lib/benchmark/runner";

interface Props {
  progress: RunProgressData | null;
}

export function RunProgress({ progress }: Props) {
  if (!progress) return null;

  const percent = progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;
  const successCount = progress.results.filter((r) => r.success).length;
  const failCount = progress.results.filter((r) => !r.success).length;

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Progress</h3>
        <span className="text-sm text-muted-foreground">
          {progress.completed} / {progress.total}
        </span>
      </div>

      <Progress value={percent} className="h-2" />

      {progress.current && (
        <div className="text-sm text-muted-foreground">
          Running: <span className="font-medium">{progress.current.provider}</span>
          {" / "}
          <span className="font-medium">{progress.current.scenario.replace(/_/g, " ")}</span>
          {" (rep "}
          {progress.current.repetition})
        </div>
      )}

      <div className="flex gap-2">
        <Badge variant="outline">{successCount} passed</Badge>
        {failCount > 0 && <Badge variant="destructive">{failCount} failed</Badge>}
        {progress.errors.length > 0 && (
          <Badge variant="destructive">{progress.errors.length} errors</Badge>
        )}
      </div>

      {progress.errors.length > 0 && (
        <div className="text-xs text-destructive space-y-1 max-h-32 overflow-y-auto">
          {progress.errors.map((err, i) => (
            <p key={i}>{err.provider}: {err.error}</p>
          ))}
        </div>
      )}
    </Card>
  );
}
