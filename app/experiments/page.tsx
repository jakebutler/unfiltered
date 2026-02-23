"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { isExperimentTelemetryEnabled } from "@/lib/telemetry/runtime";

function formatDate(ts?: number) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
}

function formatMs(value: number | null | undefined) {
  if (typeof value !== "number") return "-";
  return `${Math.round(value)}ms`;
}

function formatRuntime(startedAt?: number, endedAt?: number) {
  if (!startedAt) return "-";
  const end = endedAt ?? Date.now();
  const elapsed = Math.max(0, end - startedAt);
  const sec = Math.floor(elapsed / 1000);
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${String(rem).padStart(2, "0")}s`;
}

export default function ExperimentsPage() {
  const telemetryEnabled = isExperimentTelemetryEnabled(process.env);
  const experiments = useQuery(api.telemetry.listExperiments, telemetryEnabled ? {} : "skip");
  const studies = useQuery(api.studies.list, telemetryEnabled ? {} : "skip");
  const activeRuns = useQuery(api.telemetry.listActiveRuns, telemetryEnabled ? {} : "skip");
  const runSummaries = useQuery(api.telemetry.listRunSummaries, telemetryEnabled ? { limit: 30 } : "skip");

  const createExperiment = useMutation(api.telemetry.createExperiment);
  const startRun = useMutation(api.telemetry.startRun);
  const finishRun = useMutation(api.telemetry.finishRun);

  const [createForm, setCreateForm] = useState({
    name: "",
    scriptId: "",
    hypothesis: "",
    methodology: "",
    notes: "",
  });

  const [runForm, setRunForm] = useState({
    experimentId: "",
    variant: "baseline-current",
    prototypeId: "prototype-a",
    studyId: "",
    sessionId: "",
    operator: "",
    environment: "local",
    tagsCsv: "",
    configSnapshot: "",
    notes: "",
  });

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const selectedStudyId = runForm.studyId as Id<"studies"> | "";
  const studySessions = useQuery(
    api.sessions.listByStudy,
    selectedStudyId ? { studyId: selectedStudyId } : "skip",
  );

  const experimentOptions = (experiments ?? []) as Array<{ _id: string; name: string }>;
  const studyOptions = (studies ?? []) as Array<{ _id: string; title: string }>;
  const sessionOptions = (studySessions ?? []) as Array<{ _id: string; status: string }>;
  const activeRunItems = (activeRuns ?? []) as Array<{
    _id: Id<"telemetryRuns">;
    variant: string;
    prototypeId?: string;
    experimentId: Id<"telemetryExperiments">;
    sessionId?: Id<"sessions">;
    startedAt: number;
  }>;
  const sortedRunSummaries = useMemo(
    () => [...(runSummaries ?? [])].sort((a, b) => b.run.startedAt - a.run.startedAt),
    [runSummaries],
  );

  const handleCreateExperiment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!telemetryEnabled) {
      setStatusMessage("Experiment telemetry is disabled. Set NEXT_PUBLIC_EXPERIMENT_TELEMETRY_ENABLED=true.");
      return;
    }
    if (!createForm.name.trim()) {
      setStatusMessage("Experiment name is required.");
      return;
    }

    try {
      const id = await createExperiment({
        name: createForm.name.trim(),
        scriptId: createForm.scriptId.trim() || undefined,
        hypothesis: createForm.hypothesis.trim() || undefined,
        methodology: createForm.methodology.trim() || undefined,
        notes: createForm.notes.trim() || undefined,
      });
      setRunForm((prev) => ({ ...prev, experimentId: String(id) }));
      setCreateForm({ name: "", scriptId: "", hypothesis: "", methodology: "", notes: "" });
      setStatusMessage("Experiment created.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to create experiment.");
    }
  };

  const handleStartRun = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!telemetryEnabled) {
      setStatusMessage("Experiment telemetry is disabled. Set NEXT_PUBLIC_EXPERIMENT_TELEMETRY_ENABLED=true.");
      return;
    }
    if (!runForm.experimentId) {
      setStatusMessage("Select an experiment before starting a run.");
      return;
    }
    if (!runForm.variant.trim()) {
      setStatusMessage("Variant is required.");
      return;
    }

    try {
      await startRun({
        experimentId: runForm.experimentId as Id<"telemetryExperiments">,
        variant: runForm.variant.trim(),
        prototypeId: runForm.prototypeId.trim() || undefined,
        studyId: runForm.studyId ? (runForm.studyId as Id<"studies">) : undefined,
        sessionId: runForm.sessionId ? (runForm.sessionId as Id<"sessions">) : undefined,
        operator: runForm.operator.trim() || undefined,
        environment: runForm.environment.trim() || undefined,
        tags: runForm.tagsCsv
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        configSnapshot: runForm.configSnapshot.trim() || undefined,
        notes: runForm.notes.trim() || undefined,
      });
      setStatusMessage("Run started.");
      setRunForm((prev) => ({ ...prev, notes: "", configSnapshot: "" }));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to start run.");
    }
  };

  const handleFinishRun = async (runId: Id<"telemetryRuns">, status: "complete" | "aborted") => {
    if (!telemetryEnabled) {
      setStatusMessage("Experiment telemetry is disabled. Set NEXT_PUBLIC_EXPERIMENT_TELEMETRY_ENABLED=true.");
      return;
    }
    try {
      await finishRun({ runId, status });
      setStatusMessage(`Run marked ${status}.`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to finish run.");
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-8 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link href="/studies" className="text-sm text-muted-foreground">← Studies</Link>
          <h1 className="text-3xl font-bold mt-1">Experiments Console</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Start/stop experiment runs, link sessions, and compare latency metrics by implementation variant.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant="secondary">Series 001</Badge>
          <Badge variant="outline">Target: p95 ≤ 2s</Badge>
        </div>
      </div>

      {statusMessage && (
        <div className="rounded-md border px-3 py-2 text-sm bg-muted">{statusMessage}</div>
      )}
      {!telemetryEnabled && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Experiment telemetry is currently disabled. Set <code>NEXT_PUBLIC_EXPERIMENT_TELEMETRY_ENABLED=true</code> and ensure Convex functions are deployed before using this page.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Create Experiment</CardTitle>
            <CardDescription>
              Use one experiment for a full series; each implementation/prototype pair runs as separate runs.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={handleCreateExperiment}>
              <div className="space-y-1">
                <Label htmlFor="experimentName">Name</Label>
                <Input
                  id="experimentName"
                  value={createForm.name}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="Series 001 - Latency and Turn-Taking"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="scriptId">Script ID</Label>
                <Input
                  id="scriptId"
                  value={createForm.scriptId}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, scriptId: e.target.value }))}
                  placeholder="script-v1"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="hypothesis">Hypothesis</Label>
                <Textarea
                  id="hypothesis"
                  value={createForm.hypothesis}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, hypothesis: e.target.value }))}
                  rows={3}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="methodology">Methodology</Label>
                <Textarea
                  id="methodology"
                  value={createForm.methodology}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, methodology: e.target.value }))}
                  rows={3}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="experimentNotes">Notes</Label>
                <Textarea
                  id="experimentNotes"
                  value={createForm.notes}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, notes: e.target.value }))}
                  rows={2}
                />
              </div>
              <Button type="submit">Create Experiment</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Start Run</CardTitle>
            <CardDescription>
              Start one run per prototype pass. Link a session to auto-tag latency events.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={handleStartRun}>
              <div className="space-y-1">
                <Label htmlFor="runExperiment">Experiment</Label>
                <select
                  id="runExperiment"
                  className="w-full border rounded-md px-3 py-2 bg-background"
                  value={runForm.experimentId}
                  onChange={(e) => setRunForm((prev) => ({ ...prev, experimentId: e.target.value }))}
                >
                  <option value="">Select experiment</option>
                  {experimentOptions.map((experiment) => (
                    <option key={experiment._id} value={experiment._id}>
                      {experiment.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="variant">Variant</Label>
                  <Input
                    id="variant"
                    value={runForm.variant}
                    onChange={(e) => setRunForm((prev) => ({ ...prev, variant: e.target.value }))}
                    placeholder="baseline-current"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="prototypeId">Prototype ID</Label>
                  <Input
                    id="prototypeId"
                    value={runForm.prototypeId}
                    onChange={(e) => setRunForm((prev) => ({ ...prev, prototypeId: e.target.value }))}
                    placeholder="prototype-a"
                  />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="studyId">Study</Label>
                  <select
                    id="studyId"
                    className="w-full border rounded-md px-3 py-2 bg-background"
                    value={runForm.studyId}
                    onChange={(e) => {
                      const studyId = e.target.value;
                      setRunForm((prev) => ({ ...prev, studyId, sessionId: "" }));
                    }}
                  >
                    <option value="">No study link</option>
                    {studyOptions.map((study) => (
                      <option key={study._id} value={study._id}>
                        {study.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sessionId">Session</Label>
                  <select
                    id="sessionId"
                    className="w-full border rounded-md px-3 py-2 bg-background"
                    value={runForm.sessionId}
                    onChange={(e) => setRunForm((prev) => ({ ...prev, sessionId: e.target.value }))}
                  >
                    <option value="">No session link</option>
                    {sessionOptions.map((session) => (
                      <option key={session._id} value={session._id}>
                        {session._id.slice(-8)} ({session.status})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="operator">Operator</Label>
                  <Input
                    id="operator"
                    value={runForm.operator}
                    onChange={(e) => setRunForm((prev) => ({ ...prev, operator: e.target.value }))}
                    placeholder="jacob"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="environment">Environment</Label>
                  <Input
                    id="environment"
                    value={runForm.environment}
                    onChange={(e) => setRunForm((prev) => ({ ...prev, environment: e.target.value }))}
                    placeholder="local"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="tagsCsv">Tags (comma-separated)</Label>
                <Input
                  id="tagsCsv"
                  value={runForm.tagsCsv}
                  onChange={(e) => setRunForm((prev) => ({ ...prev, tagsCsv: e.target.value }))}
                  placeholder="series-001,baseline,prototype-a"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="configSnapshot">Config Snapshot (JSON/string)</Label>
                <Textarea
                  id="configSnapshot"
                  value={runForm.configSnapshot}
                  onChange={(e) => setRunForm((prev) => ({ ...prev, configSnapshot: e.target.value }))}
                  rows={2}
                  placeholder='{"minParticipantSilenceMs":4000}'
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="runNotes">Run Notes</Label>
                <Textarea
                  id="runNotes"
                  value={runForm.notes}
                  onChange={(e) => setRunForm((prev) => ({ ...prev, notes: e.target.value }))}
                  rows={2}
                />
              </div>
              <Button type="submit">Start Run</Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Run Protocol Checklist</CardTitle>
          <CardDescription>Use this for each run to keep traces comparable.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal list-inside text-sm space-y-1">
            <li>Select experiment + variant + prototype and start run before participant starts speaking.</li>
            <li>Link study/session when available so latency events are auto-tagged.</li>
            <li>Execute the same interviewee script without improvising sequence.</li>
            <li>Stop run immediately after the session and mark as complete or aborted.</li>
            <li>Capture anomalies in run notes (network, audio device, browser issues).</li>
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active Runs</CardTitle>
          <CardDescription>Stop these when session execution ends.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {activeRunItems.length === 0 && (
            <p className="text-sm text-muted-foreground">No active runs.</p>
          )}
          {activeRunItems.map((run) => (
            <div key={run._id} className="border rounded-md p-3 flex items-start justify-between gap-3 flex-wrap">
              <div className="space-y-1 text-sm">
                <div className="font-medium">{run.variant} · {run.prototypeId ?? "prototype-unknown"}</div>
                <div className="text-muted-foreground">Experiment: {run.experimentId}</div>
                <div className="text-muted-foreground">Session: {run.sessionId ?? "(not linked)"}</div>
                <div className="text-muted-foreground">Started: {formatDate(run.startedAt)} · Runtime: {formatRuntime(run.startedAt)}</div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => handleFinishRun(run._id, "aborted")}>Abort</Button>
                <Button size="sm" onClick={() => handleFinishRun(run._id, "complete")}>Complete</Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Run Summaries</CardTitle>
          <CardDescription>
            p50/p90/p95 are computed from turn-level latency events linked to each run.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {sortedRunSummaries.length === 0 && (
            <p className="text-sm text-muted-foreground">No run summaries yet.</p>
          )}
          {sortedRunSummaries.map(({ run, experimentName, metrics }) => (
            <div key={run._id} className="border rounded-md p-3 space-y-2">
              <div className="flex justify-between gap-4 flex-wrap">
                <div>
                  <div className="font-medium">{experimentName}</div>
                  <div className="text-sm text-muted-foreground">
                    {run.variant} · {run.prototypeId ?? "prototype-unknown"} · {run.status}
                  </div>
                </div>
                <div className="text-sm text-muted-foreground">
                  {formatDate(run.startedAt)}
                </div>
              </div>
              <div className="grid md:grid-cols-4 gap-3 text-sm">
                <div className="rounded border p-2">
                  <div className="text-muted-foreground">Response Start</div>
                  <div>p50 {formatMs(metrics.responseStartMs.p50)}</div>
                  <div>p90 {formatMs(metrics.responseStartMs.p90)}</div>
                  <div>p95 {formatMs(metrics.responseStartMs.p95)}</div>
                </div>
                <div className="rounded border p-2">
                  <div className="text-muted-foreground">Decision</div>
                  <div>p50 {formatMs(metrics.decisionMs.p50)}</div>
                  <div>p90 {formatMs(metrics.decisionMs.p90)}</div>
                  <div>p95 {formatMs(metrics.decisionMs.p95)}</div>
                </div>
                <div className="rounded border p-2">
                  <div className="text-muted-foreground">TTS Startup</div>
                  <div>p50 {formatMs(metrics.ttsStartupMs.p50)}</div>
                  <div>p90 {formatMs(metrics.ttsStartupMs.p90)}</div>
                  <div>p95 {formatMs(metrics.ttsStartupMs.p95)}</div>
                </div>
                <div className="rounded border p-2">
                  <div className="text-muted-foreground">Trigger Delay</div>
                  <div>p50 {formatMs(metrics.triggerDelayMs.p50)}</div>
                  <div>p90 {formatMs(metrics.triggerDelayMs.p90)}</div>
                  <div>p95 {formatMs(metrics.triggerDelayMs.p95)}</div>
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                Turns: {metrics.turnsObserved} · Events: {metrics.eventCount} · Runtime: {formatRuntime(run.startedAt, run.endedAt)}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
