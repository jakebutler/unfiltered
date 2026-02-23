export interface TranscriptWordForSnippet {
  text: string;
  startTime: number;
  duration?: number;
}

export interface TranscriptSegmentForSnippet {
  _id?: string;
  _creationTime?: number;
  speakerId: string;
  taskId?: string;
  text: string;
  startTime: number;
  endTime?: number;
  words?: TranscriptWordForSnippet[];
}

export interface MomentRangeForSnippet {
  tStart: number;
  tEnd: number;
  taskId?: string;
}

const SHORT_ACK_REGEX = /^(yeah|yes|yep|ok|okay|uh[- ]?huh|mm[- ]?hmm|hmm|right|sure|got it|i see)[.!?,]*$/i;

interface Candidate {
  text: string;
  start: number;
  end: number;
  overlapSec: number;
  distanceToCenter: number;
  substantive: boolean;
  creationTime: number;
}

interface MergedSegment {
  taskId?: string;
  text: string;
  startTime: number;
  endTime: number;
  creationTime: number;
}

function normalizeText(text: string): string {
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
  if (!baseEndsSentence) return true;
  if (nextTrim.split(" ").filter(Boolean).length <= 3) return true;
  if (/^[a-z]/.test(nextTrim)) return true;
  if (/^[.,!?;:]/.test(nextTrim)) return true;
  return false;
}

function isSubstantiveSnippet(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (SHORT_ACK_REGEX.test(normalized)) return false;
  const wordCount = normalized.split(" ").filter(Boolean).length;
  return wordCount >= 4 || normalized.length >= 24;
}

function getBounds(segment: TranscriptSegmentForSnippet): { start: number; end: number } {
  const startFromSegment = Number.isFinite(segment.startTime) ? segment.startTime : NaN;
  const firstWordStart = segment.words?.find((w) => Number.isFinite(w.startTime))?.startTime;
  const start = Number.isFinite(startFromSegment)
    ? startFromSegment
    : Number.isFinite(firstWordStart)
      ? (firstWordStart as number)
      : 0;

  const endFromSegment = Number.isFinite(segment.endTime) && (segment.endTime as number) > start
    ? (segment.endTime as number)
    : NaN;
  if (Number.isFinite(endFromSegment)) {
    return { start, end: endFromSegment as number };
  }

  const lastWord = segment.words
    ?.filter((w) => Number.isFinite(w.startTime))
    .sort((a, b) => a.startTime - b.startTime)
    .at(-1);

  if (lastWord) {
    const duration = Number.isFinite(lastWord.duration) && (lastWord.duration as number) > 0 ? (lastWord.duration as number) : 0.25;
    return { start, end: Math.max(start + 0.01, lastWord.startTime + duration) };
  }

  return { start, end: start + 0.25 };
}

function getOverlap(start: number, end: number, tStart: number, tEnd: number): number {
  return Math.max(0, Math.min(end, tEnd) - Math.max(start, tStart));
}

function sortForSnippets(segments: TranscriptSegmentForSnippet[]): TranscriptSegmentForSnippet[] {
  return [...segments].sort((a, b) => {
    const createdDiff = (a._creationTime ?? 0) - (b._creationTime ?? 0);
    if (createdDiff !== 0) return createdDiff;
    const startDiff = a.startTime - b.startTime;
    if (startDiff !== 0) return startDiff;
    return (a._id ?? "").localeCompare(b._id ?? "");
  });
}

function mergeSegmentsForSnippets(segments: TranscriptSegmentForSnippet[]): MergedSegment[] {
  const ordered = sortForSnippets(segments);
  const merged: MergedSegment[] = [];
  for (const segment of ordered) {
    const text = normalizeText(segment.text);
    if (!text) continue;
    const { start, end } = getBounds(segment);
    const prev = merged[merged.length - 1];
    const gap = prev ? start - prev.endTime : Number.POSITIVE_INFINITY;
    const canMerge =
      Boolean(prev) &&
      prev.taskId === segment.taskId &&
      gap >= 0 &&
      gap <= 1.25 &&
      shouldMergeText(prev.text, text);

    if (canMerge && prev) {
      prev.text = joinText(prev.text, text);
      prev.endTime = Math.max(prev.endTime, end);
      continue;
    }

    merged.push({
      taskId: segment.taskId,
      text,
      startTime: start,
      endTime: end,
      creationTime: segment._creationTime ?? 0,
    });
  }
  return merged;
}

export function pickTranscriptSnippetsForMoment(
  moment: MomentRangeForSnippet,
  transcriptSegments: TranscriptSegmentForSnippet[],
  maxSnippets = 3,
): string[] {
  const participantSegments = transcriptSegments.filter((segment) => {
    if (segment.speakerId !== "participant") return false;
    return normalizeText(segment.text).length > 0;
  });

  const scopedToTask = moment.taskId
    ? participantSegments.filter((segment) => segment.taskId === moment.taskId)
    : participantSegments;
  const pool = scopedToTask.length > 0 ? scopedToTask : participantSegments;
  if (pool.length === 0) return [];
  const mergedPool = mergeSegmentsForSnippets(pool);

  const center = (moment.tStart + moment.tEnd) / 2;
  const candidates: Candidate[] = mergedPool.map((segment) => {
    const text = normalizeText(segment.text);
    const start = segment.startTime;
    const end = segment.endTime;
    const midpoint = (start + end) / 2;
    return {
      text,
      start,
      end,
      overlapSec: getOverlap(start, end, moment.tStart, moment.tEnd),
      distanceToCenter: Math.abs(midpoint - center),
      substantive: isSubstantiveSnippet(text),
      creationTime: segment.creationTime,
    };
  });

  const overlaps = candidates.filter((candidate) => candidate.overlapSec > 0);
  const ranked = (overlaps.length > 0 ? overlaps : candidates)
    .sort((a, b) => {
      if (a.substantive !== b.substantive) return a.substantive ? -1 : 1;
      if (a.overlapSec !== b.overlapSec) return b.overlapSec - a.overlapSec;
      if (a.distanceToCenter !== b.distanceToCenter) return a.distanceToCenter - b.distanceToCenter;
      if (a.creationTime !== b.creationTime) return a.creationTime - b.creationTime;
      return a.start - b.start;
    });

  const substantiveRanked = ranked.filter((candidate) => candidate.substantive);
  const selectionPool = substantiveRanked.length > 0 ? substantiveRanked : ranked;
  const snippets: string[] = [];
  const seen = new Set<string>();
  for (const candidate of selectionPool) {
    if (seen.has(candidate.text)) continue;
    snippets.push(candidate.text);
    seen.add(candidate.text);
    if (snippets.length >= maxSnippets) break;
  }
  return snippets;
}
