import Link from "next/link";
import { ClipboardList, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { StudyCard } from "@/components/studies/study-card";
import { listStudies } from "@/lib/studies/actions";

export default async function StudiesPage() {
  const studies = await listStudies();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Studies</h1>
          <p className="text-sm text-muted-foreground">
            Create research projects, generate interview guides, and run
            sessions with synthetic and real participants.
          </p>
        </div>
        <Button asChild>
          <Link href="/studies/new">
            <Plus className="h-4 w-4" />
            New study
          </Link>
        </Button>
      </header>

      {studies.length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="h-6 w-6" />}
          title="No studies yet"
          description="Create your first study to start designing an interview guide and running synthetic users against it."
          action={
            <Button asChild>
              <Link href="/studies/new">
                <Plus className="h-4 w-4" />
                Create your first study
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {studies.map((s) => (
            <StudyCard
              key={s.id}
              study={{
                id: s.id,
                name: s.name,
                description: s.description,
                status: s.status,
                studyType: s.studyType,
                targetUrl: s.targetUrl,
                createdAt: s.createdAt,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
