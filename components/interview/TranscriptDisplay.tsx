import { ScrollArea } from "@/components/ui/scroll-area";
import { Fragment, useEffect, useMemo, useRef } from "react";

interface Word { text: string; startTime: number; duration: number; }
interface Segment {
  _id: string;
  _creationTime?: number;
  taskId?: string;
  speakerId: "participant" | "interviewer";
  text: string;
  words: Word[];
  startTime: number;
}
interface DisplayLine {
  key: string;
  speakerId: "participant" | "interviewer";
  text: string;
  endTime: number;
  startsTask: boolean;
  taskNumber: number | null;
}

function segmentEndTime(segment: Segment): number {
  const lastWord = segment.words[segment.words.length - 1];
  if (!lastWord) return segment.startTime;
  return lastWord.startTime + lastWord.duration;
}

function joinText(base: string, next: string): string {
  if (!base) return next;
  if (!next) return base;
  if (/^[.,!?;:)\]]/.test(next)) return `${base}${next}`;
  return `${base} ${next}`.replace(/\s+/g, " ").trim();
}

function sortSegmentsForDisplay(segments: Segment[]): Segment[] {
  return [...segments].sort((a, b) => {
    const createdDiff = (a._creationTime ?? 0) - (b._creationTime ?? 0);
    if (createdDiff !== 0) return createdDiff;
    const startDiff = a.startTime - b.startTime;
    if (startDiff !== 0) return startDiff;
    return a._id.localeCompare(b._id);
  });
}

export function mergeSegmentsForDisplay(segments: Segment[]): DisplayLine[] {
  const ordered = sortSegmentsForDisplay(segments);
  const lines: DisplayLine[] = [];
  let prevTaskId: string | null = null;
  let lastRenderedTaskId: string | null = null;
  const taskNumbersById = new Map<string, number>();

  for (const segment of ordered) {
    const text = segment.text.trim();
    if (!text) continue;
    const endTime = segmentEndTime(segment);
    const prev = lines[lines.length - 1];
    const gap = prev ? segment.startTime - prev.endTime : Number.POSITIVE_INFINITY;
    const fragmentLike = text.split(/\s+/).length <= 3 || /^[.,!?;:]/.test(text) || /^[a-z]/.test(text);
    const prevEndsSentence = prev ? /[.!?]$/.test(prev.text.trim()) : true;
    const segmentTaskId = segment.taskId ?? null;
    const taskNumber = segmentTaskId
      ? (taskNumbersById.get(segmentTaskId) ?? (() => {
        const next = taskNumbersById.size + 1;
        taskNumbersById.set(segmentTaskId, next);
        return next;
      })())
      : null;
    const startsTask = segmentTaskId !== null && lastRenderedTaskId !== null && segmentTaskId !== lastRenderedTaskId;
    const canMerge =
      Boolean(prev) &&
      prev.speakerId === segment.speakerId &&
      prevTaskId === segmentTaskId &&
      gap >= 0 &&
      gap <= 1.25 &&
      (!prevEndsSentence || fragmentLike);

    if (canMerge && prev) {
      prev.text = joinText(prev.text, text);
      prev.endTime = Math.max(prev.endTime, endTime);
      continue;
    }

    lines.push({
      key: segment._id,
      speakerId: segment.speakerId,
      text,
      endTime,
      startsTask,
      taskNumber,
    });
    prevTaskId = segmentTaskId;
    if (segmentTaskId !== null) {
      lastRenderedTaskId = segmentTaskId;
    }
  }

  return lines;
}

export function TranscriptDisplay({ segments }: { segments: Segment[] }) {
  const displayLines = useMemo(() => mergeSegmentsForDisplay(segments), [segments]);
  const rootRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const viewport = rootRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;

    const updateStickToBottom = () => {
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      stickToBottomRef.current = distanceFromBottom < 56;
    };

    updateStickToBottom();
    viewport.addEventListener("scroll", updateStickToBottom);
    return () => viewport.removeEventListener("scroll", updateStickToBottom);
  }, []);

  useEffect(() => {
    const viewport = rootRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport || !stickToBottomRef.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [displayLines.length]);

  return (
    <div ref={rootRef} className="h-full min-h-0">
      <ScrollArea className="h-full border rounded p-2 bg-muted/30">
        <div className="space-y-2 text-sm">
          {displayLines.map((line) => (
            <Fragment key={line.key}>
              {line.startsTask && line.taskNumber && (
                <div className="my-3 flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  <span>Task {line.taskNumber}</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <div className={`${line.speakerId === "interviewer" ? "text-blue-700 font-medium" : "text-foreground"}`}>
                <span className="text-xs text-muted-foreground mr-1">{line.speakerId === "interviewer" ? "AI:" : "You:"}</span>
                {line.text}
              </div>
            </Fragment>
          ))}
          {displayLines.length === 0 && <p className="text-muted-foreground italic">Transcript will appear here…</p>}
        </div>
      </ScrollArea>
    </div>
  );
}
