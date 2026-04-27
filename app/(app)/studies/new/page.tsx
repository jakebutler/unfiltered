import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { NewStudyForm } from "@/components/studies/new-study-form";

export default function NewStudyPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div>
        <Link
          href="/studies"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Studies
        </Link>
      </div>

      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">New study</h1>
        <p className="text-sm text-muted-foreground">
          Give your study a name and pick a type. You can fill in the
          interview guide after this.
        </p>
      </header>

      <NewStudyForm />
    </div>
  );
}
