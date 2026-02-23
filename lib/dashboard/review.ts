export interface ReviewWord {
  text: string;
  startTime: number;
  duration?: number;
}

export interface ReviewSegment {
  _id: string;
  _creationTime?: number;
  speakerId: "participant" | "interviewer";
  text: string;
  startTime: number;
  endTime?: number;
  words?: ReviewWord[];
}

export interface TranscriptFocusInput {
  tStart: number;
  tEnd: number;
  referencedSnippet?: string;
}

export interface MergedReviewLine {
  key: string;
  speakerId: "participant" | "interviewer";
  text: string;
  startTime: number;
  endTime: number;
}

export function sortSegmentsForReview<T extends ReviewSegment>(segments: T[]): T[] {
  return [...segments].sort((a, b) => {
    const createdDiff = (a._creationTime ?? 0) - (b._creationTime ?? 0);
    if (createdDiff !== 0) return createdDiff;
    const startDiff = a.startTime - b.startTime;
    if (startDiff !== 0) return startDiff;
    return a._id.localeCompare(b._id);
  });
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeDisplayText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function joinText(base: string, next: string): string {
  if (!base) return next;
  if (!next) return base;
  if (/^[.,!?;:)\]]/.test(next)) return `${base}${next}`;
  return `${base} ${next}`.replace(/\s+/g, " ").trim();
}

function shouldMergeText(base: string, next: string): boolean {
  const baseTrim = base.trim();
  const nextTrim = next.trim();
  if (!baseTrim || !nextTrim) return true;
  const baseEndsSentence = /[.!?]$/.test(baseTrim);
  const nextWordCount = nextTrim.split(" ").filter(Boolean).length;
  if (!baseEndsSentence) return true;
  if (nextWordCount <= 3) return true;
  if (/^[a-z]/.test(nextTrim)) return true;
  if (/^[.,!?;:]/.test(nextTrim)) return true;
  return false;
}

function getSegmentBounds(segment: ReviewSegment): { start: number; end: number } {
  const start = Number.isFinite(segment.startTime) ? segment.startTime : 0;
  if (Number.isFinite(segment.endTime) && (segment.endTime as number) > start) {
    return { start, end: segment.endTime as number };
  }
  const lastWord = segment.words
    ?.filter((word) => Number.isFinite(word.startTime))
    .sort((a, b) => a.startTime - b.startTime)
    .at(-1);
  if (lastWord) {
    const duration = Number.isFinite(lastWord.duration) && (lastWord.duration as number) > 0
      ? (lastWord.duration as number)
      : 0.25;
    return { start, end: Math.max(start + 0.01, lastWord.startTime + duration) };
  }
  return { start, end: start + 0.25 };
}

export function mergeSegmentsForReview(segments: ReviewSegment[]): MergedReviewLine[] {
  const ordered = sortSegmentsForReview(segments);
  const lines: MergedReviewLine[] = [];
  for (const segment of ordered) {
    const text = normalizeDisplayText(segment.text);
    if (!text) continue;
    const { start, end } = getSegmentBounds(segment);
    const prev = lines[lines.length - 1];
    const gap = prev ? start - prev.endTime : Number.POSITIVE_INFINITY;
    const canMerge =
      Boolean(prev) &&
      prev.speakerId === segment.speakerId &&
      gap >= 0 &&
      gap <= 1.25 &&
      shouldMergeText(prev.text, text);

    if (canMerge && prev) {
      prev.text = joinText(prev.text, text);
      prev.endTime = Math.max(prev.endTime, end);
      prev.key = `${prev.key}|${segment._id}`;
      continue;
    }

    lines.push({
      key: segment._id,
      speakerId: segment.speakerId,
      text,
      startTime: start,
      endTime: end,
    });
  }
  return lines;
}

function getOverlap(start: number, end: number, tStart: number, tEnd: number): number {
  return Math.max(0, Math.min(end, tEnd) - Math.max(start, tStart));
}

export function findTranscriptFocusIndex(
  orderedSegments: ReviewSegment[],
  input: TranscriptFocusInput,
): number {
  if (orderedSegments.length === 0) return -1;

  const snippet = normalize(input.referencedSnippet ?? "");
  if (snippet) {
    const matchedIdx = orderedSegments.findIndex((segment) => normalize(segment.text).includes(snippet));
    if (matchedIdx >= 0) return matchedIdx;
  }

  const center = (input.tStart + input.tEnd) / 2;
  const scored = orderedSegments
    .map((segment, index) => {
      const { start, end } = getSegmentBounds(segment);
      const overlap = getOverlap(start, end, input.tStart, input.tEnd);
      const midpoint = (start + end) / 2;
      return { index, overlap, distance: Math.abs(midpoint - center) };
    })
    .sort((a, b) => {
      if (a.overlap !== b.overlap) return b.overlap - a.overlap;
      return a.distance - b.distance;
    });

  return scored[0]?.index ?? 0;
}
