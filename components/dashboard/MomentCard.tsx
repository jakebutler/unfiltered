import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const CATEGORY_LABELS: Record<string, string> = {
  copy_language: "Copy / Language",
  discoverability: "Discoverability",
  system_status_feedback: "System Feedback",
  navigation_ia: "Navigation / IA",
  form_field_friction: "Form Field",
  task_prompt_issue: "Task Prompt",
  error_recovery: "Error Recovery",
  other: "Other",
};

interface Props {
  moment: {
    _id: string;
    tStart: number;
    tEnd: number;
    taskId: string;
    frictionPeak: number;
    signalTags: string[];
    candidateFindingLabel?: string;
    category?: string;
    interpretation?: string;
    recommendations?: string[];
    verificationQuestion?: string;
    labelConfidence?: number;
    evidence: { transcriptSnippets: string[] };
    engagementSnapshot?: { state: string; confidence: number };
  };
  taskLabel?: string;
}

export function MomentCard({ moment, taskLabel }: Props) {
  const severity = moment.frictionPeak >= 70 ? "HIGH" : moment.frictionPeak >= 40 ? "MED" : "LOW";
  const severityVariant = { HIGH: "destructive", MED: "secondary", LOW: "outline" } as const;
  const formatTime = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

  return (
    <Card className="border-l-4 border-l-orange-400">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs text-muted-foreground">{formatTime(moment.tStart)} – {formatTime(moment.tEnd)} · {taskLabel ?? moment.taskId}</p>
            <CardTitle className="text-base mt-1">{moment.candidateFindingLabel ?? "Friction moment"}</CardTitle>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <Badge variant={severityVariant[severity]}>{severity} {moment.frictionPeak}</Badge>
            {moment.category && <Badge variant="outline">{CATEGORY_LABELS[moment.category] ?? moment.category}</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {moment.evidence.transcriptSnippets.length > 0 && (
          <blockquote className="border-l-2 pl-3 italic text-muted-foreground">
            &ldquo;{moment.evidence.transcriptSnippets[0]}&rdquo;
          </blockquote>
        )}
        {moment.signalTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {moment.signalTags.map((tag) => <Badge key={tag} variant="outline" className="text-xs">{tag.replace(/_/g, " ")}</Badge>)}
          </div>
        )}
        {moment.interpretation && <p className="text-muted-foreground">{moment.interpretation}</p>}
        {moment.engagementSnapshot && (
          <p className="text-xs text-muted-foreground">Camera: {moment.engagementSnapshot.state.replace(/_/g, " ")} ({Math.round(moment.engagementSnapshot.confidence * 100)}% confidence)</p>
        )}
        {moment.recommendations && moment.recommendations.length > 0 && (
          <div>
            <p className="font-medium text-xs uppercase tracking-wide mb-1">Recommendations</p>
            <ul className="list-disc list-inside space-y-1">
              {moment.recommendations.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </div>
        )}
        {moment.verificationQuestion && (
          <p className="text-xs bg-muted rounded p-2"><span className="font-medium">Verify: </span>{moment.verificationQuestion}</p>
        )}
      </CardContent>
    </Card>
  );
}
