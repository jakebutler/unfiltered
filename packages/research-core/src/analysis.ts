import { z } from 'zod';
import { canonical } from '../../research-capture/src/proof';

export const ANALYSIS_LIMITS = Object.freeze({ sessions: 6, sources: 24, frames: 4, frameBytes: 120_000, inputBytes: 64_000, outputBytes: 32_000, findings: 12, text: 2_000, jobMs: 120_000, reportDays: 90, grantDays: 7, viewerMs: 15 * 60_000, unlockAttempts: 8, unlockWindowMs: 15 * 60_000 });
export const sourceKinds = ['self-report', 'dom-event', 'screen-observation', 'camera-observation', 'audio', 'capture-gap'] as const;
export type SourceKind = typeof sourceKinds[number];
export type Selection = { sessionId: string; kind: SourceKind; id: string; start: number; end: number };
export type Evidence = Selection & { hash: string; consentEpoch: number; sharingEpoch: number; retainApprovedExcerpts: boolean; text: string | null };
export type Finding = { id: string; statement: string; type: 'self-report' | 'observed-dom' | 'tentative-screen' | 'tentative-camera' | 'interpretation'; supports: string[]; counterevidence: string[]; limitations: string };
export type Excerpt = { evidenceId: string; text: string };
export type RawGrant = { evidenceId: string; view: boolean; download: boolean };
export const findingSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), statement: z.string().min(1).max(ANALYSIS_LIMITS.text), type: z.enum(['self-report', 'observed-dom', 'tentative-screen', 'tentative-camera', 'interpretation']), supports: z.array(z.string()).min(1).max(12), counterevidence: z.array(z.string()).max(12), limitations: z.string().max(ANALYSIS_LIMITS.text) }).strict();
export const findingsSchema = z.array(findingSchema).min(1).max(ANALYSIS_LIMITS.findings);
export function evidenceId(e: Selection): string { return `${e.kind}:${e.id}:${e.start}:${e.end}`; }
export async function hashValue(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function checkSelections(selections: Selection[]): void {
  if (!selections.length || selections.length > ANALYSIS_LIMITS.sources || new Set(selections.map(s => s.sessionId)).size > ANALYSIS_LIMITS.sessions || new Set(selections.map(evidenceId)).size !== selections.length) throw new Error('Choose distinct bounded evidence');
  for (const s of selections) if (!Number.isSafeInteger(s.start) || !Number.isSafeInteger(s.end) || s.start < 0 || s.end <= s.start) throw new Error('Invalid evidence interval');
  if (selections.filter(s => ['screen-observation', 'camera-observation'].includes(s.kind)).length > ANALYSIS_LIMITS.frames) throw new Error('At most four selected frames');
}
export function validateFindings(value: unknown, evidence: Evidence[]): Finding[] {
  const findings = findingsSchema.parse(value), refs = new Map(evidence.map(e => [evidenceId(e), e]));
  if (new Set(findings.map(f => f.id)).size !== findings.length || new TextEncoder().encode(JSON.stringify(findings)).length > ANALYSIS_LIMITS.outputBytes) throw new Error('Analysis exceeds its envelope');
  for (const f of findings) {
    const ids = [...f.supports, ...f.counterevidence];
    if (new Set(ids).size !== ids.length || ids.some(id => !refs.has(id))) throw new Error('Finding cites unavailable evidence');
    if (!f.supports.some(id => !['audio', 'capture-gap'].includes(refs.get(id)!.kind))) throw new Error('Audio metadata and capture gaps do not establish an observation');
    const substantive = f.supports.map(id => refs.get(id)!).filter(e => !['audio', 'capture-gap'].includes(e.kind));
    if (substantive.every(e => e.kind === 'camera-observation') && f.type !== 'tentative-camera') throw new Error('Camera-only findings must remain tentative visible cues');
    const required: Partial<Record<Finding['type'], SourceKind>> = { 'self-report': 'self-report', 'observed-dom': 'dom-event', 'tentative-screen': 'screen-observation', 'tentative-camera': 'camera-observation' };
    if (required[f.type] && !f.supports.some(id => refs.get(id)?.kind === required[f.type])) throw new Error('Finding provenance differs from its evidence');
    if (f.type === 'tentative-camera' && /\b(?:emotion|confus(?:ed|ion)|anxious|depress(?:ed|ion)|honest|dishonest|diagnos\w*|pain|personality|intent)\b/i.test(f.statement)) throw new Error('Camera observations must describe visible cues only');
  }
  return findings;
}
export function validatePublication(findings: Finding[], evidence: Evidence[], excerpts: Excerpt[], grants: RawGrant[]): void {
  validateFindings(findings, evidence);
  const refs = new Map(evidence.map(e => [evidenceId(e), e]));
  if (excerpts.length > ANALYSIS_LIMITS.sources || grants.length > ANALYSIS_LIMITS.sources || new Set(excerpts.map(e => e.evidenceId)).size !== excerpts.length || new Set(grants.map(g => g.evidenceId)).size !== grants.length) throw new Error('Invalid publication selections');
  for (const e of excerpts) {
    const source = refs.get(e.evidenceId);
    // Narrative model text is never treated as a quotation or raw excerpt.
    if (!source?.text || e.text !== source.text || e.text.length > ANALYSIS_LIMITS.text) throw new Error('Approve an exact selected source excerpt');
  }
  for (const g of grants) if (!refs.has(g.evidenceId) || !g.view && !g.download || refs.get(g.evidenceId)?.kind === 'capture-gap') throw new Error('Invalid raw grant');
}
export function validateCitationCoverage(findings: Finding[], excerpts: Excerpt[], grants: RawGrant[]): void {
  const inspectable = new Set([...excerpts.map(e => e.evidenceId), ...grants.filter(g => g.view || g.download).map(g => g.evidenceId)]);
  for (const f of findings) if ([...f.supports, ...f.counterevidence].some(id => !inspectable.has(id))) throw new Error('Every published citation needs an approved excerpt or selected raw grant');
}
