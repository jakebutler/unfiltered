"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getPrimaryScenarioNames, getScenarioNames } from "@/lib/benchmark/scenarios";
import type { ProviderType } from "@/lib/voice/types";

const AVAILABLE_PROVIDERS: { id: ProviderType; label: string }[] = [
  { id: "vapi", label: "Vapi" },
  { id: "openai_whisper_tts", label: "OpenAI Whisper + TTS" },
  { id: "openai_realtime", label: "OpenAI Realtime" },
  { id: "assemblyai", label: "AssemblyAI" },
  { id: "speechmatics", label: "Speechmatics" },
];

interface Props {
  onSubmit: (config: { name: string; providers: ProviderType[]; scenarios: string[]; repetitions: number }) => void;
  isRunning: boolean;
}

export function RunConfigForm({ onSubmit, isRunning }: Props) {
  const [name, setName] = useState(`Benchmark ${new Date().toLocaleDateString()}`);
  const [selectedProviders, setSelectedProviders] = useState<ProviderType[]>(["speechmatics"]);
  const [selectedScenarios, setSelectedScenarios] = useState<string[]>(getPrimaryScenarioNames());
  const [repetitions, setRepetitions] = useState(3);
  const [showAllScenarios, setShowAllScenarios] = useState(false);

  const allScenarios = showAllScenarios ? getScenarioNames() : getPrimaryScenarioNames();

  const toggleProvider = (id: ProviderType) => {
    setSelectedProviders((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  const toggleScenario = (name: string) => {
    setSelectedScenarios((prev) =>
      prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]
    );
  };

  return (
    <Card className="p-6 space-y-6">
      <div className="space-y-2">
        <Label htmlFor="run-name">Run Name</Label>
        <Input id="run-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="space-y-2">
        <Label>Providers</Label>
        <div className="grid grid-cols-2 gap-2">
          {AVAILABLE_PROVIDERS.map((provider) => (
            <label key={provider.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selectedProviders.includes(provider.id)}
                onCheckedChange={() => toggleProvider(provider.id)}
              />
              {provider.label}
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Scenarios</Label>
          <button
            type="button"
            onClick={() => setShowAllScenarios(!showAllScenarios)}
            className="text-xs text-muted-foreground underline"
          >
            {showAllScenarios ? "Show primary only" : "Show all variants"}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
          {allScenarios.map((scenario) => (
            <label key={scenario} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selectedScenarios.includes(scenario)}
                onCheckedChange={() => toggleScenario(scenario)}
              />
              {scenario.replace(/_/g, " ")}
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="repetitions">Repetitions</Label>
        <Input
          id="repetitions"
          type="number"
          min={1}
          max={20}
          value={repetitions}
          onChange={(e) => setRepetitions(parseInt(e.target.value) || 1)}
        />
      </div>

      <Button
        onClick={() => onSubmit({ name, providers: selectedProviders, scenarios: selectedScenarios, repetitions })}
        disabled={isRunning || selectedProviders.length === 0 || selectedScenarios.length === 0}
        className="w-full"
      >
        {isRunning ? "Running..." : "Start Benchmark"}
      </Button>
    </Card>
  );
}
