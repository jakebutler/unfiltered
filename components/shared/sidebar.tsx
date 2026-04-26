"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ClipboardList,
  Settings,
  Users,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/studies", label: "Studies", icon: ClipboardList },
  { href: "/personas", label: "Personas", icon: Users },
  { href: "/findings", label: "Findings", icon: Sparkles },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar({
  workspaceName,
  userEmail,
}: {
  workspaceName?: string;
  userEmail?: string;
}) {
  const pathname = usePathname();
  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r bg-muted/20">
      <div className="border-b p-6">
        <div className="text-base font-semibold tracking-tight">Unfiltered</div>
        {workspaceName ? (
          <div className="mt-1 text-xs text-muted-foreground">
            {workspaceName}
          </div>
        ) : null}
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-3">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive =
            pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      {userEmail ? (
        <div className="border-t p-4 text-xs text-muted-foreground">
          {userEmail}
        </div>
      ) : null}
    </aside>
  );
}
