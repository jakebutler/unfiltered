import { ClipboardList, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";

// Studies list — populated from D1 in Phase 1 once Drizzle queries
// are in place and WorkOS auth has provisioned the workspace.
export default function StudiesPage() {
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
        <Button disabled>
          <Plus className="h-4 w-4" />
          New study
        </Button>
      </header>

      <EmptyState
        icon={<ClipboardList className="h-6 w-6" />}
        title="No studies yet"
        description="Wires up in Phase 1 once the guide creator and database queries land. For now this is the empty state shell."
      />
    </div>
  );
}
