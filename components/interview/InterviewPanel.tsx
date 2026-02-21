import { StatusIndicator } from "./StatusIndicator";
import { TranscriptDisplay } from "./TranscriptDisplay";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

type Status = "listening" | "thinking" | "speaking";
interface Segment { _id: string; speakerId: "participant" | "interviewer"; text: string; words: { text: string; startTime: number; duration: number }[]; startTime: number; }

interface Props {
  status: Status;
  segments: Segment[];
  currentTask: { id: string; label: string } | null;
  taskIndex: number;
  totalTasks: number;
  onEndTurn: () => void;
}

export function InterviewPanel({ status, segments, currentTask, taskIndex, totalTasks, onEndTurn }: Props) {
  const progress = totalTasks > 0 ? ((taskIndex) / totalTasks) * 100 : 0;
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
      <Button variant="outline" size="sm" onClick={onEndTurn} className="self-start">
        End Turn →
      </Button>
    </div>
  );
}
