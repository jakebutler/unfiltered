import { StatusIndicator } from "./StatusIndicator";
import { TranscriptDisplay } from "./TranscriptDisplay";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { getEndTurnLabel } from "@/lib/interview/endTurn";

type Status = "listening" | "thinking" | "speaking";
interface Segment { _id: string; speakerId: "participant" | "interviewer"; text: string; words: { text: string; startTime: number; duration: number }[]; startTime: number; }

interface Props {
  status: Status;
  segments: Segment[];
  currentTask: { id: string; label: string } | null;
  taskIndex: number;
  totalTasks: number;
  onEndTurn: () => void;
  pipelineHealth?: {
    camera: "ok" | "error" | "off";
    cameraNote: string;
    mouseWindows: number;
    signalWindows: number;
    decideEvents: number;
    lastSignalWindowEndSec: number | null;
    signalProcessorError: string | null;
  };
}

export function InterviewPanel({ status, segments, currentTask, taskIndex, totalTasks, onEndTurn, pipelineHealth }: Props) {
  const progress = totalTasks > 0 ? ((taskIndex) / totalTasks) * 100 : 0;
  const endTurnLabel = getEndTurnLabel({ taskIndex, totalTasks });
  return (
    <div className="flex flex-col h-full p-4 gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-sm">AI Interviewer</h2>
        <StatusIndicator status={status} />
      </div>
      {currentTask && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Task {taskIndex + 1} of {totalTasks}</p>
          <Progress value={progress} className="h-1" />
          <p className="text-sm font-medium">{currentTask.label}</p>
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        <TranscriptDisplay segments={segments} />
      </div>
      {pipelineHealth && (
        <div className="rounded border border-border bg-muted/30 p-2 text-[11px] leading-4 space-y-1">
          <p className="font-medium text-foreground">Pipeline Health</p>
          <p className="text-muted-foreground">
            Camera:{" "}
            <span className={pipelineHealth.camera === "ok" ? "text-emerald-700" : pipelineHealth.camera === "error" ? "text-amber-700" : "text-muted-foreground"}>
              {pipelineHealth.camera}
            </span>
            {pipelineHealth.cameraNote ? ` (${pipelineHealth.cameraNote})` : ""}
          </p>
          <p className="text-muted-foreground">Mouse windows: {pipelineHealth.mouseWindows}</p>
          <p className="text-muted-foreground">Signal windows: {pipelineHealth.signalWindows}</p>
          <p className="text-muted-foreground">Decide events: {pipelineHealth.decideEvents}</p>
          <p className="text-muted-foreground">
            Last signal window end: {pipelineHealth.lastSignalWindowEndSec === null ? "n/a" : `${Math.round(pipelineHealth.lastSignalWindowEndSec)}s`}
          </p>
          {pipelineHealth.signalProcessorError && (
            <p className="text-amber-700">Signal processor error: {pipelineHealth.signalProcessorError}</p>
          )}
        </div>
      )}
      <Button variant="outline" size="sm" onClick={onEndTurn} className="self-start">
        {endTurnLabel}
      </Button>
    </div>
  );
}
