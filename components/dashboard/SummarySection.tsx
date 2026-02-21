import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

interface Props {
  themes: string[];
  sessionFriction: number;
  momentCount: number;
  taskCount: number;
}

export function SummarySection({ themes, sessionFriction, momentCount, taskCount }: Props) {
  const severity = sessionFriction >= 70 ? "HIGH" : sessionFriction >= 40 ? "MED" : "LOW";
  const severityColor = { HIGH: "destructive", MED: "secondary", LOW: "outline" } as const;
  return (
    <div className="grid grid-cols-3 gap-4">
      <Card className="col-span-2">
        <CardHeader><CardTitle>Top Friction Themes</CardTitle></CardHeader>
        <CardContent>
          {themes.length > 0 ? (
            <ol className="list-decimal list-inside space-y-2">
              {themes.map((t, i) => <li key={i} className="text-sm">{t}</li>)}
            </ol>
          ) : <p className="text-sm text-muted-foreground">Themes not yet generated.</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Session Score</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-3xl font-bold">{sessionFriction}</span>
            <Badge variant={severityColor[severity]}>{severity}</Badge>
          </div>
          <Progress value={sessionFriction} className="h-2" />
          <p className="text-xs text-muted-foreground">{momentCount} friction moment(s) across {taskCount} task(s)</p>
        </CardContent>
      </Card>
    </div>
  );
}
