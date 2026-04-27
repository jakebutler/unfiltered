import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  guide_in_progress: "Guide in progress",
  ready: "Ready",
  live: "Live",
  complete: "Complete",
  archived: "Archived",
};

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  draft: "secondary",
  guide_in_progress: "secondary",
  ready: "default",
  live: "default",
  complete: "outline",
  archived: "outline",
};

export interface StudyCardData {
  id: string;
  name: string;
  description: string | null;
  status: string;
  studyType: string;
  targetUrl: string | null;
  createdAt: Date;
}

export function StudyCard({ study }: { study: StudyCardData }) {
  return (
    <Link href={`/studies/${study.id}`} className="block group">
      <Card className="transition-colors group-hover:border-foreground/30">
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">{study.name}</CardTitle>
            <div className="text-xs text-muted-foreground">
              {study.studyType === "discovery" ? "Discovery" : "Usability"} ·{" "}
              {new Date(study.createdAt).toLocaleDateString()}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[study.status] ?? "secondary"}>
              {STATUS_LABEL[study.status] ?? study.status}
            </Badge>
            <ArrowRight
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                "group-hover:translate-x-0.5 group-hover:text-foreground",
              )}
            />
          </div>
        </CardHeader>
        {study.description ? (
          <CardContent className="pt-0 text-sm text-muted-foreground line-clamp-2">
            {study.description}
          </CardContent>
        ) : null}
      </Card>
    </Link>
  );
}
