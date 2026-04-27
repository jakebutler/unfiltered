import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, Sparkles, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { getStudy } from "@/lib/studies/actions";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  guide_in_progress: "Guide in progress",
  ready: "Ready",
  live: "Live",
  complete: "Complete",
  archived: "Archived",
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function StudyDetailPage({ params }: PageProps) {
  const { id } = await params;
  const study = await getStudy(id);
  if (!study) notFound();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div>
        <Link
          href="/studies"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Studies
        </Link>
      </div>

      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {study.name}
          </h1>
          <Badge variant="secondary">
            {STATUS_LABEL[study.status] ?? study.status}
          </Badge>
        </div>
        {study.description ? (
          <p className="max-w-2xl text-sm text-muted-foreground">
            {study.description}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>
            {study.studyType === "discovery" ? "Discovery" : "Usability"}
          </span>
          <span>·</span>
          <span>
            Created {new Date(study.createdAt).toLocaleDateString()}
          </span>
          {study.targetUrl ? (
            <>
              <span>·</span>
              <a
                href={study.targetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                {study.targetUrl}
                <ExternalLink className="h-3 w-3" />
              </a>
            </>
          ) : null}
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4" />
              Interview guide
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Generate a structured guide with goals, audience, and tasks.
              Wires up in Phase 1.2.
            </p>
            <Button disabled variant="outline" size="sm" className="w-fit">
              Open guide creator
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              Synthetic personas
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Generate AI personas to pressure-test the guide before sending
              it to real participants. Wires up in Phase 1.3.
            </p>
            <Button disabled variant="outline" size="sm" className="w-fit">
              Generate personas
            </Button>
          </CardContent>
        </Card>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Sessions</h2>
        <EmptyState
          title="No sessions yet"
          description="Once a guide is finalized you can run synthetic interviews or invite real participants. Sessions land here."
        />
      </section>
    </div>
  );
}
