"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function StudiesPage() {
  const studies = useQuery(api.studies.list);
  return (
    <div className="max-w-2xl mx-auto p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Studies</h1>
        <div className="flex gap-2">
          <Button variant="outline" asChild><Link href="/experiments">Experiments</Link></Button>
          <Button asChild><Link href="/studies/new">New Study</Link></Button>
        </div>
      </div>
      <div className="space-y-3">
        {studies?.map((s: { _id: string; title: string; tasks: { id: string; label: string }[]; decideMode: "A" | "B" | "AB" }) => (
          <Card key={s._id}>
            <CardHeader>
              <CardTitle>{s.title}</CardTitle>
              <CardDescription>{s.tasks.length} task(s) · Mode {s.decideMode}</CardDescription>
              <div className="flex gap-2 mt-2">
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/studies/${s._id}`}>Manage</Link>
                </Button>
              </div>
            </CardHeader>
          </Card>
        ))}
        {studies?.length === 0 && <p className="text-muted-foreground">No studies yet.</p>}
      </div>
    </div>
  );
}
