import * as React from "react";

import { cn } from "@/lib/utils";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="rounded-full bg-muted p-3 text-muted-foreground">
          {icon}
        </div>
      ) : null}
      <div className="text-base font-medium">{title}</div>
      {description ? (
        <div className="max-w-sm text-sm text-muted-foreground">
          {description}
        </div>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
