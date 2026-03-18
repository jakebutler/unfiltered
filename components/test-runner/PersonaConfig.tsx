"use client";
import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface Distribution {
  gender?: Record<string, number>;
  techSavviness?: Record<string, number>;
  [key: string]: unknown;
}

interface PersonaConfigProps {
  distribution: Distribution;
  onChange: (distribution: Distribution) => void;
}

export function PersonaConfig({ distribution, onChange }: PersonaConfigProps) {
  const [genderDistribution, setGenderDistribution] = useState({
    male: distribution.gender?.male ?? 33,
    female: distribution.gender?.female ?? 33,
    nonBinary: distribution.gender?.["non-binary"] ?? 34,
  });

  const [techDistribution, setTechDistribution] = useState({
    low: distribution.techSavviness?.["1-2"] ?? 25,
    medium: distribution.techSavviness?.["3"] ?? 50,
    high: distribution.techSavviness?.["4-5"] ?? 25,
  });

  const handleGenderChange = (type: string, value: number) => {
    const updated = { ...genderDistribution, [type]: value };
    setGenderDistribution(updated);

    const total = Object.values(updated).reduce((a, b) => a + b, 0);
    const normalized = {
      male: Math.round((updated.male / total) * 100),
      female: Math.round((updated.female / total) * 100),
      "non-binary": Math.round((updated.nonBinary / total) * 100),
    };

    onChange({
      ...distribution,
      gender: normalized,
    });
  };

  const handleTechChange = (level: string, value: number) => {
    const updated = { ...techDistribution, [level]: value };
    setTechDistribution(updated);

    const total = Object.values(updated).reduce((a, b) => a + b, 0);
    const normalized = {
      "1-2": Math.round((updated.low / total) * 100),
      "3": Math.round((updated.medium / total) * 100),
      "4-5": Math.round((updated.high / total) * 100),
    };

    onChange({
      ...distribution,
      techSavviness: normalized,
    });
  };

  return (
    <div className="space-y-6">
      {/* Gender Distribution */}
      <div className="space-y-4">
        <Label>Gender Distribution (%)</Label>
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label className="text-sm">Male</Label>
            <Input
              type="number"
              min={0}
              max={100}
              value={genderDistribution.male}
              onChange={(e) => handleGenderChange("male", parseInt(e.target.value) || 0)}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">Female</Label>
            <Input
              type="number"
              min={0}
              max={100}
              value={genderDistribution.female}
              onChange={(e) => handleGenderChange("female", parseInt(e.target.value) || 0)}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">Non-Binary</Label>
            <Input
              type="number"
              min={0}
              max={100}
              value={genderDistribution.nonBinary}
              onChange={(e) => handleGenderChange("nonBinary", parseInt(e.target.value) || 0)}
            />
          </div>
        </div>
      </div>

      {/* Tech Savviness Distribution */}
      <div className="space-y-4">
        <Label>Tech Savviness Distribution (%)</Label>
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label className="text-sm">Low (1-2)</Label>
            <Input
              type="number"
              min={0}
              max={100}
              value={techDistribution.low}
              onChange={(e) => handleTechChange("low", parseInt(e.target.value) || 0)}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">Medium (3)</Label>
            <Input
              type="number"
              min={0}
              max={100}
              value={techDistribution.medium}
              onChange={(e) => handleTechChange("medium", parseInt(e.target.value) || 0)}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">High (4-5)</Label>
            <Input
              type="number"
              min={0}
              max={100}
              value={techDistribution.high}
              onChange={(e) => handleTechChange("high", parseInt(e.target.value) || 0)}
            />
          </div>
        </div>
      </div>

      {/* Reset */}
      <Button
        variant="outline"
        onClick={() => {
          setGenderDistribution({ male: 33, female: 33, nonBinary: 34 });
          setTechDistribution({ low: 25, medium: 50, high: 25 });
          onChange({});
        }}
      >
        Reset to Defaults
      </Button>
    </div>
  );
}
