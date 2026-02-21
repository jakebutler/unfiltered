"use client";
import { useEffect, useRef } from "react";
import simpleheat from "simpleheat";

interface HeatmapBin { x: number; y: number; count: number; }

interface Props {
  bins: HeatmapBin[];
  prototypeUrl: string;
  width?: number;
  height?: number;
}

export function HeatmapView({ bins, prototypeUrl, width = 800, height = 500 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || bins.length === 0) return;
    const heat = simpleheat(canvas);
    // bins have x/y as 0-1 fractions of the prototype area
    const points: [number, number, number][] = bins.map(b => [
      b.x * width,
      b.y * height,
      b.count,
    ]);
    heat.data(points).max(Math.max(...bins.map(b => b.count)));
    heat.radius(25, 15);
    heat.draw(0.05);
  }, [bins, width, height]);

  return (
    <div className="relative rounded overflow-hidden border" style={{ width, height }}>
      <iframe
        src={prototypeUrl}
        className="absolute inset-0 w-full h-full border-0 opacity-60"
        sandbox="allow-scripts allow-same-origin"
        title="Prototype heatmap background"
      />
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="absolute inset-0 pointer-events-none"
      />
    </div>
  );
}
