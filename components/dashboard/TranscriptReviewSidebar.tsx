"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { findTranscriptFocusIndex, mergeSegmentsForReview } from "@/lib/dashboard/review";
import { useEffect, useMemo, useRef } from "react";

interface TranscriptWord {
  text: string;
  startTime: number;
  duration: number;
}

interface TranscriptSegment {
  _id: string;
  _creationTime?: number;
  taskId?: string;
  speakerId: "participant" | "interviewer";
  text: string;
  words?: TranscriptWord[];
  startTime: number;
  endTime?: number;
}

interface MomentForReview {
  _id: string;
  tStart: number;
  tEnd: number;
  taskId: string;
  candidateFindingLabel?: string;
  evidence: { transcriptSnippets: string[] };
}

interface Props {
  moment: MomentForReview;
  taskLabel?: string;
  transcripts: TranscriptSegment[];
  onClose: () => void;
}

function renderHighlightedText(text: string, snippet: string) {
  const cleanSnippet = snippet.trim();
  if (!cleanSnippet) return text;
  const sourceLower = text.toLowerCase();
  const needleLower = cleanSnippet.toLowerCase();
  const idx = sourceLower.indexOf(needleLower);
  if (idx < 0) return text;
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + cleanSnippet.length);
  const after = text.slice(idx + cleanSnippet.length);
  return (
    <>
      {before}
      <mark className="rounded bg-yellow-200 px-0.5">{match}</mark>
      {after}
    </>
  );
}

export function TranscriptReviewSidebar({ moment, taskLabel, transcripts, onClose }: Props) {
  const referencedSnippet = moment.evidence.transcriptSnippets[0] ?? "";
  const mergedLines = useMemo(() => mergeSegmentsForReview(transcripts), [transcripts]);
  const focusIndex = useMemo(
    () =>
      findTranscriptFocusIndex(
        mergedLines.map((line) => ({
          _id: line.key,
          speakerId: line.speakerId,
          text: line.text,
          startTime: line.startTime,
          endTime: line.endTime,
        })),
        {
        tStart: moment.tStart,
        tEnd: moment.tEnd,
        referencedSnippet,
      },
      ),
    [mergedLines, moment.tStart, moment.tEnd, referencedSnippet],
  );
  const focusElementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    focusElementRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [moment._id, focusIndex]);

  return (
    <aside className="border rounded-lg bg-background h-[70vh] lg:h-[calc(100vh-4rem)] flex flex-col">
      <div className="p-3 border-b space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">Transcript Verification</p>
            <p className="text-xs text-muted-foreground">{taskLabel ?? moment.taskId}</p>
          </div>
          <Button type="button" size="xs" variant="ghost" onClick={onClose}>Close</Button>
        </div>
        {moment.candidateFindingLabel && (
          <p className="text-xs text-muted-foreground">{moment.candidateFindingLabel}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            {Math.floor(moment.tStart / 60)}:{String(Math.floor(moment.tStart % 60)).padStart(2, "0")} - {Math.floor(moment.tEnd / 60)}:{String(Math.floor(moment.tEnd % 60)).padStart(2, "0")}
          </Badge>
          {referencedSnippet && <Badge variant="secondary">Referenced snippet</Badge>}
        </div>
      </div>
      <ScrollArea className="h-full">
        <div className="p-3 space-y-3 text-sm">
          {mergedLines.map((line, index) => {
            const isFocus = index === focusIndex;
            return (
              <div
                key={line.key}
                ref={isFocus ? focusElementRef : undefined}
                className={`rounded border p-2 ${isFocus ? "border-yellow-500 bg-yellow-50" : "border-transparent bg-muted/25"}`}
              >
                <p className="text-[11px] text-muted-foreground mb-1">
                  {line.speakerId === "interviewer" ? "AI" : "Participant"}
                </p>
                <p className="leading-relaxed">{renderHighlightedText(line.text, referencedSnippet)}</p>
              </div>
            );
          })}
          {mergedLines.length === 0 && (
            <p className="text-sm text-muted-foreground italic">No transcript data captured for this session.</p>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
