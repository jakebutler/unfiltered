"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PersonaConfig } from "@/components/test-runner/PersonaConfig";

export default function TestRunnerPage() {
  const studies = useQuery(api.studies.list);

  const [selectedStudyId, setSelectedStudyId] = useState<string>("");
  const [personaCount, setPersonaCount] = useState(5);
  const [distribution, setDistribution] = useState<Record<string, unknown>>({});
  const [isCreating, setIsCreating] = useState(false);

  const handleCreateTestRun = async () => {
    if (!selectedStudyId) return;
    setIsCreating(true);
    try {
      // In production, this would call the actual mutation
      // For now, show a message that Convex needs to be connected
      alert("Connect Convex deployment to enable test run creation. Run: npx convex dev");
      setIsCreating(false);
    } catch (error) {
      console.error("Failed to create test run:", error);
      setIsCreating(false);
    }
  };

  return (
    <div className="container mx-auto py-8 max-w-4xl">
      <h1 className="text-3xl font-bold mb-8">Agent Test Runner</h1>
      <p className="text-muted-foreground mb-8">
        Create and run automated UX tests with AI-powered interviewee agents.
      </p>

      <div className="grid gap-6">
        {/* Study Selection */}
        <Card>
          <CardHeader>
            <CardTitle>Select Study</CardTitle>
            <CardDescription>Choose an existing study to test</CardDescription>
          </CardHeader>
          <CardContent>
            {studies ? (
              <div className="grid gap-2">
                {studies.map((study) => (
                  <button
                    key={study._id}
                    onClick={() => setSelectedStudyId(study._id)}
                    className={`p-4 rounded-lg border text-left transition-colors ${
                      selectedStudyId === study._id
                        ? "border-primary bg-primary/5"
                        : "hover:bg-muted"
                    }`}
                  >
                    <div className="font-medium">{study.title}</div>
                    <div className="text-sm text-muted-foreground">
                      {study.tasks.length} tasks · Mode {study.decideMode}
                    </div>
                  </button>
                ))}
                {studies.length === 0 && (
                  <p className="text-muted-foreground">
                    No studies found. Create a study first.
                  </p>
                )}
              </div>
            ) : (
              <div>Loading studies...</div>
            )}
          </CardContent>
        </Card>

        {/* Persona Configuration */}
        <Card>
          <CardHeader>
            <CardTitle>Persona Configuration</CardTitle>
            <CardDescription>
              Define the demographic distribution of simulated users
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="count">Number of Personas</Label>
              <Input
                id="count"
                type="number"
                min={1}
                max={100}
                value={personaCount}
                onChange={(e) => setPersonaCount(parseInt(e.target.value) || 1)}
              />
            </div>

            <PersonaConfig
              distribution={distribution}
              onChange={setDistribution}
            />
          </CardContent>
        </Card>

        {/* Launch */}
        <Card>
          <CardHeader>
            <CardTitle>Launch Test Run</CardTitle>
            <CardDescription>
              Start the automated testing session
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={handleCreateTestRun}
              disabled={!selectedStudyId || isCreating}
              className="w-full"
            >
              {isCreating ? "Creating..." : "Create Test Run"}
            </Button>
          </CardContent>
        </Card>

        {/* Recent Test Runs */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Test Runs</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              View existing test runs from the study detail page.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
