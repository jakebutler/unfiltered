"use client";
import { useRef, useEffect } from "react";

interface Props {
  url: string;
  onMouseEvent: (event: { type: "move" | "click" | "scroll"; x?: number; y?: number; button?: string; delta?: number; t: number }) => void;
}

export function PrototypeFrame({ url, onMouseEvent }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const toRelative = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
    };

    const onMove = (e: MouseEvent) => onMouseEvent({ type: "move", ...toRelative(e), t: Date.now() });
    const onClick = (e: MouseEvent) => onMouseEvent({ type: "click", ...toRelative(e), button: e.button === 0 ? "left" : "right", t: Date.now() });
    const onScroll = (e: WheelEvent) => onMouseEvent({ type: "scroll", delta: e.deltaY, t: Date.now() });

    el.addEventListener("mousemove", onMove);
    el.addEventListener("click", onClick);
    el.addEventListener("wheel", onScroll);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("click", onClick);
      el.removeEventListener("wheel", onScroll);
    };
  }, [onMouseEvent]);

  return (
    <div ref={containerRef} className="relative w-full h-full">
      <iframe src={url} className="w-full h-full border-0 rounded-l" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" title="Prototype" />
    </div>
  );
}
