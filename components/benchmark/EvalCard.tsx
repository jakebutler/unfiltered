"use client";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { EVALUATION_DIMENSIONS, RATING_LABELS } from "@/lib/benchmark/scenarios";
import type { RatingScore, EvaluationDimensionId } from "@/lib/benchmark/scenarios";

interface Props {
  sessionId: string;
  scenario: string;
  providerHidden: boolean;
  provider?: string;
  onSubmit: (ratings: Record<EvaluationDimensionId, RatingScore>, notes: string) => void;
}

export function EvalCard({ sessionId, scenario, providerHidden, provider, onSubmit }: Props) {
  const [ratings, setRatings] = useState<Record<string, RatingScore>>({});
  const [notes, setNotes] = useState("");

  const setRating = (dimensionId: string, score: RatingScore) => {
    setRatings((prev) => ({ ...prev, [dimensionId]: score }));
  };

  const allRated = EVALUATION_DIMENSIONS.every((d) => ratings[d.id] != null);

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">{scenario.replace(/_/g, " ")}</p>
          <p className="text-xs text-muted-foreground">Session: {sessionId.slice(0, 12)}...</p>
        </div>
        {providerHidden ? (
          <Badge variant="outline">Provider hidden</Badge>
        ) : (
          <Badge>{provider}</Badge>
        )}
      </div>

      <div className="space-y-3">
        {EVALUATION_DIMENSIONS.map((dim) => (
          <div key={dim.id} className="space-y-1">
            <Label className="text-xs">{dim.name}</Label>
            <p className="text-xs text-muted-foreground">{dim.prompt}</p>
            <div className="flex gap-2">
              {([1, 2, 3] as RatingScore[]).map((score) => (
                <Button
                  key={score}
                  variant={ratings[dim.id] === score ? "default" : "outline"}
                  size="sm"
                  onClick={() => setRating(dim.id, score)}
                  className="text-xs"
                >
                  {score} - {RATING_LABELS[score]}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`notes-${sessionId}`}>Notes (optional)</Label>
        <Textarea
          id={`notes-${sessionId}`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Any additional observations..."
          rows={2}
        />
      </div>

      <Button
        onClick={() => onSubmit(ratings as Record<EvaluationDimensionId, RatingScore>, notes)}
        disabled={!allRated}
        className="w-full"
      >
        Submit Evaluation
      </Button>
    </Card>
  );
}
