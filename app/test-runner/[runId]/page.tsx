"use client";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";

// Demo data for when Convex is not connected
const demoTestRun = {
  _id: "demo-run-1",
  status: "pending",
  createdAt: Date.now(),
  config: {
    count: 5,
    distribution: { gender: { male: 50, female: 50 } },
    parallel: true,
  },
  resultsSummary: undefined as {
    completedCount: number;
    avgFriction?: number;
    avgSUS?: number;
    totalActions?: number;
  } | undefined,
  personas: [
    {
      _id: "p1",
      demographics: { age: 28, gender: "male", occupation: "Software Engineer", techSavviness: 5 },
      traits: ["detail-oriented", "early-adopter"],
    },
    {
      _id: "p2",
      demographics: { age: 35, gender: "female", occupation: "Marketing Manager", techSavviness: 3 },
      traits: ["visual-learner", "price-conscious"],
    },
  ],
  sessionIds: [],
};

export default function TestRunDetailPage() {
  const params = useParams();
  // testRunId available for future Convex integration
  void params.runId;

  // Using demo data - in production this would use Convex
  const testRun = demoTestRun;
  const [isStarting, setIsStarting] = useState(false);

  const handleStart = () => {
    setIsStarting(true);
    // In production, this would call the mutation
    setTimeout(() => {
      alert("Connect Convex deployment to run actual tests. Run: npx convex dev");
      setIsStarting(false);
    }, 1000);
  };

  const statusColor: Record<string, string> = {
    pending: "bg-yellow-500",
    running: "bg-blue-500",
    complete: "bg-green-500",
    failed: "bg-red-500",
  };

  return (
    <div className="container mx-auto py-8 max-w-4xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Test Run</h1>
          <p className="text-muted-foreground">
            {testRun.config.count} personas · Created {new Date(testRun.createdAt).toLocaleString()}
          </p>
        </div>
        <Badge className={statusColor[testRun.status]}>
          {testRun.status}
        </Badge>
      </div>

      {/* Summary */}
      {testRun.resultsSummary && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Results Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-4 text-center">
              <div>
                <div className="text-2xl font-bold">
                  {testRun.resultsSummary.completedCount}
                </div>
                <div className="text-sm text-muted-foreground">Completed</div>
              </div>
              <div>
                <div className="text-2xl font-bold">
                  {testRun.resultsSummary.avgFriction?.toFixed(0) ?? "-"}
                </div>
                <div className="text-sm text-muted-foreground">Avg Friction</div>
              </div>
              <div>
                <div className="text-2xl font-bold">
                  {testRun.resultsSummary.avgSUS?.toFixed(0) ?? "-"}
                </div>
                <div className="text-sm text-muted-foreground">Avg SUS</div>
              </div>
              <div>
                <div className="text-2xl font-bold">
                  {testRun.resultsSummary.totalActions ?? "-"}
                </div>
                <div className="text-sm text-muted-foreground">Total Actions</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Personas */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Personas</CardTitle>
          <CardDescription>Simulated users in this test run</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2">
            {testRun.personas?.map((persona: { _id: string; demographics: { age: number; occupation: string; gender: string; techSavviness: number }; traits: string[] } | null, index: number) => (
              persona && (
                <div key={persona._id} className="p-3 border rounded-lg">
                  <div className="flex justify-between">
                    <span className="font-medium">Persona {index + 1}</span>
                    <span className="text-sm text-muted-foreground">
                      {persona.demographics.age}yo {persona.demographics.occupation}
                    </span>
                  </div>
                  <div className="flex gap-2 mt-1">
                    <Badge variant="outline">{persona.demographics.gender}</Badge>
                    <Badge variant="outline">Tech: {persona.demographics.techSavviness}/5</Badge>
                    {persona.traits.slice(0, 2).map((trait: string) => (
                      <Badge key={trait} variant="secondary">{trait}</Badge>
                    ))}
                  </div>
                </div>
              )
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Sessions */}
      {testRun.sessionIds && testRun.sessionIds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Sessions</CardTitle>
            <CardDescription>Completed agent sessions</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2">
              {testRun.sessionIds?.map((sessionId: string) => (
                <Link
                  key={sessionId}
                  href={`/dashboard/${sessionId}`}
                  className="p-3 border rounded-lg hover:bg-muted transition-colors block"
                >
                  <div className="flex justify-between">
                    <span>Session {sessionId}</span>
                    <span className="text-sm text-primary">View Findings →</span>
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Actions */}
      {testRun.status === "pending" && (
        <Card>
          <CardHeader>
            <CardTitle>Start Test</CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              onClick={handleStart}
              disabled={isStarting}
              className="w-full"
            >
              {isStarting ? "Starting..." : "Start Test Run"}
            </Button>
            <p className="text-sm text-muted-foreground mt-2">
              This will launch {testRun.config.count} interviewee agent instances.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
