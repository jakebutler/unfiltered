"use client";
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function NewStudyPage() {
  const router = useRouter();
  const createStudy = useMutation(api.studies.create);
  const [title, setTitle] = useState("");
  const [prototypeUrl, setPrototypeUrl] = useState("");
  const [prdText, setPrdText] = useState("");
  const [decideMode, setDecideMode] = useState<"A" | "B" | "AB">("B");
  const [tasks, setTasks] = useState([{ id: "t1", label: "" }]);
  const [loading, setLoading] = useState(false);

  const addTask = () => {
    if (tasks.length >= 3) return;
    setTasks([...tasks, { id: `t${tasks.length + 1}`, label: "" }]);
  };

  const updateTask = (index: number, label: string) => {
    const next = [...tasks];
    next[index] = { ...next[index], label };
    setTasks(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const validTasks = tasks.filter((t) => t.label.trim());
    if (!validTasks.length) { setLoading(false); return; }
    const id = await createStudy({ title, prototypeUrl, prdText: prdText || undefined, tasks: validTasks, decideMode });
    router.push(`/studies/${id}`);
  };

  return (
    <div className="max-w-xl mx-auto p-8">
      <Card>
        <CardHeader><CardTitle>New Study</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label className="text-base">Study Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </div>

            <div className="space-y-2">
              <Label className="text-base">Prototype URL (will be shown in iframe)</Label>
              <Input value={prototypeUrl} onChange={(e) => setPrototypeUrl(e.target.value)} placeholder="https://..." required />
            </div>

            <div className="space-y-2">
              <Label className="text-base">PRD / Context (optional)</Label>
              <Textarea value={prdText} onChange={(e) => setPrdText(e.target.value)} rows={4} placeholder="Paste product context here..." />
            </div>

            <div className="space-y-2">
              <Label className="text-base">Tasks (1–3)</Label>
              {tasks.map((t, i) => (
                <Input key={t.id} placeholder={`Task ${i + 1}…`} value={t.label} onChange={(e) => updateTask(i, e.target.value)} />
              ))}
              {tasks.length < 3 && <Button type="button" variant="outline" size="sm" className="mt-1" onClick={addTask}>+ Add Task</Button>}
            </div>

            <div className="space-y-2">
              <Label className="text-base">Decide Mode</Label>
              <Select value={decideMode} onValueChange={(v) => setDecideMode(v as "A" | "B" | "AB")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="A">A — Deterministic rules</SelectItem>
                  <SelectItem value="B">B — Bounded LLM (GLM-5)</SelectItem>
                  <SelectItem value="AB">A/B — Alternate sessions</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={loading} className="w-full">{loading ? "Creating…" : "Create Study"}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
