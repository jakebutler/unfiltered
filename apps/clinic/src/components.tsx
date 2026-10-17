import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, CheckCheck, FileText, Pencil, ShieldCheck, X } from 'lucide-react';
import type { DeliveryView, SourceSpan, SourceTurn, StaffIdentity, TopicView } from '../../../packages/clinic-contract/src/index';
import { patientSourceTransformLabels, sourceSegments, sourceTransformLabels } from './adaptive-state';

export const topicLabels: Record<TopicView['status'], string> = {
  'not-started': 'Not started', 'more-detail-needed': 'More detail needed',
  'ready-for-review': 'Ready for review', 'stopped-with-gaps': 'Stopped here · detail missing',
};
export const answerLabels = {
  answered: 'Patient reported', negative: 'Reported no', unknown: 'Not known',
  declined: 'Chose not to answer', uncertain: 'Not sure', 'not-asked': 'Not asked', conflicting: 'Needs clarification',
};
/** Patient-facing answer states: plain first-person wording for the same recorded states. */
export const patientAnswerLabels: Record<keyof typeof answerLabels, string> = {
  answered: 'Your answer', negative: 'You said no', unknown: 'You didn’t know',
  declined: 'You chose not to answer', uncertain: 'You weren’t sure', 'not-asked': 'Not asked yet', conflicting: 'Needs a quick check',
};
export type Audience = 'patient' | 'staff';
export const roleLabels: Record<StaffIdentity['role'], string> = {
  physician: 'Physician', 'nurse-practitioner': 'Nurse practitioner', 'physician-assistant': 'Physician assistant',
  'registered-dietitian': 'Registered dietitian', administrative: 'Administrative staff',
};
export const outcomeLabels = { pending: 'Delivery pending', 'external-change': 'Changed outside clinic action', received: 'Awaiting review', reviewed: 'Reviewed', 'needs-information': 'More information requested', declined: 'Declined', resolved: 'Outcome recorded' };
export const deliveryLabels = { pending: 'Confirmation saved · delivery pending', incomplete: 'Delivery incomplete', unknown: 'Delivery not yet verified', conflict: 'Delivery needs attention', received: 'Complete delivery verified' };
export const workDeliveryLabels = { pending: 'Work delivery pending', verified: 'Work received', unknown: 'Work delivery not yet verified', conflict: 'Work delivery needs attention' };
export const responsibilityLabels = { medical: 'Medical team', nutrition: 'Nutrition team', administrative: 'Administrative team' };
const interpretationGapLabels: Record<NonNullable<TopicView['interpretationGaps']>[number]['reason'], string> = {
  ambiguous: 'The meaning needs clarification.', 'unsupported-target': 'These words did not match an intake field.', capacity: 'These words exceeded what the interpreter could safely structure in one turn.',
  conflict: 'These saved reports differ or their association needs clarification.', ownership: 'Who or what these words refer to needs clarification.',
  'invalid-type': 'This proposed value could not be safely recorded.', 'unsupported-state': 'This proposed answer state needs clarification.',
  'unsupported-unknown': 'The proposed missing answer does not agree with the saved wording.', 'value-not-in-source': 'The proposed value does not agree with the saved wording.',
  'temporal-crop': 'The proposed timing omitted part of the saved wording.', 'recognition-unreviewed': 'Recognized speech has not been reviewed.',
  'unaddressed-source': 'Some saved wording has not been accounted for.',
};
const patientGapLabels: Record<NonNullable<TopicView['interpretationGaps']>[number]['reason'], string> = {
  ambiguous: 'This could mean more than one thing.', 'unsupported-target': 'These words didn’t match a question on this form.', capacity: 'There was more here than could be captured in one step.',
  conflict: 'These answers seem to differ, or it’s unclear which goes with which.', ownership: 'It’s unclear who or what these words are about.',
  'invalid-type': 'This couldn’t be recorded in the expected format.', 'unsupported-state': 'This answer needs a quick check.',
  'unsupported-unknown': 'This was marked unknown, but your words may say more.', 'value-not-in-source': 'This answer didn’t match your exact words, so it wasn’t recorded.',
  'temporal-crop': 'Part of the timing you mentioned may be missing.', 'recognition-unreviewed': 'This came from speech-to-text and hasn’t been checked.',
  'unaddressed-source': 'Part of what you wrote hasn’t been captured yet.',
};

function formatDate(value: string | undefined, full: boolean) {
  if (!value || Number.isNaN(new Date(value).getTime())) return 'Not recorded';
  return new Intl.DateTimeFormat(undefined, full
    ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }
    : { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
export const time = (value?: string) => formatDate(value, false);
export const dateTime = (value?: string) => formatDate(value, true);
export function detailDisplayText(detail: NonNullable<TopicView['details']>[number]) {
  if (detail.id === 'lastMeasuredWeight.representsCurrent' && ['true', 'false'].includes(detail.text ?? '')) return detail.text === 'true' ? 'Yes' : 'No';
  if (detail.id === 'currentWeightEstimate.statedAt' && detail.text && /^\d{4}-\d{2}-\d{2}T/.test(detail.text) && !Number.isNaN(new Date(detail.text).getTime())) return dateTime(detail.text);
  return detail.text;
}

export function WorkHistory({ work }: { work: DeliveryView['work'][number] }) {
  if (!work.history?.length) return null;
  return <details className="work-history"><summary>Recorded outcome history · {work.history.length}</summary>{work.history.map(action => <div className="work-history-entry" key={action.actionId}><p>{outcomeLabels[action.outcome as keyof typeof outcomeLabels] ?? action.outcome}</p><p>{action.note}</p><p className="metadata">{action.author} · {dateTime(action.at)}</p></div>)}</details>;
}

export function Button({ children, variant = 'secondary', className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'text' }) {
  return <button {...props} type={type} className={`button button--${variant} ${className}`}>{children}</button>;
}
export function Notice({ children, tone = 'info', action }: { children: ReactNode; tone?: 'info' | 'attention' | 'urgent'; action?: ReactNode }) {
  return <div className={`notice notice--${tone}`} role={tone === 'info' ? 'status' : 'alert'}><AlertCircle size={19} aria-hidden="true" /><div>{children}{action && <div className="notice-actions">{action}</div>}</div></div>;
}
export function Header({ staff = false, children }: { staff?: boolean; children?: ReactNode }) {
  return <><a className="skip-link" href="#main">Skip to main content</a><header className="site-header"><a className="brand" href={staff ? '/staff' : '/'} aria-label="Corvo Clinic home">Corvo<span className="brand-divider" /><span>Clinic</span></a><div className="header-actions">{children}</div></header><div className="demo-strip"><ShieldCheck size={15} aria-hidden="true" /><span>Synthetic demo <span className="demo-detail">· Fictional clinic · Use only the provided synthetic details</span></span></div></>;
}
export function Loading({ staff = false }: { staff?: boolean }) {
  return <><Header staff={staff} /><main id="main" tabIndex={-1} className="loading-page" aria-busy="true"><p>Opening {staff ? 'your workspace' : 'Corvo Clinic'}…</p><div className="skeleton skeleton-title" /><div className="skeleton" /><div className="skeleton skeleton-short" /></main></>;
}
export type SourceSelection = { topicId: string; title: string; ids: string[]; provenance?: SourceSpan[] };

export function SourceInspector({ title, ids, sources, provenance, onClose, audience = 'staff' }: { title: string; ids: string[]; sources: SourceTurn[]; provenance?: SourceSpan[]; onClose: () => void; audience?: Audience }) {
  const patient = audience === 'patient';
  const transformLabels = patient ? patientSourceTransformLabels : sourceTransformLabels;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (ref.current?.getClientRects().length) {
      ref.current.focus({ preventScroll: true });
      ref.current.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [title, ids.join(',')]);
  const selected = ids.map(id => sources.find(source => source.id === id)).filter((source): source is SourceTurn => Boolean(source));
  const missing = ids.length - selected.length;
  return <section ref={ref} tabIndex={-1} className="source-inspector" aria-label={`${patient ? 'Your words' : 'Original answers'} for ${title}`}>
    <div className="section-heading"><h3>{patient ? 'Your words' : 'Original answers'}</h3><Button variant="text" onClick={onClose} aria-label={patient ? 'Close your words' : 'Close original answers'}><X size={18} aria-hidden="true" /></Button></div>
    <p className="source-topic">{title}</p>
    {(!selected.length || missing > 0) && <Notice tone="attention">{!selected.length ? 'No source answer is available for this detail.' : `${missing} referenced source answer${missing === 1 ? ' is' : 's are'} unavailable.`} This is a gap in the record.</Notice>}
    {selected.map(source => {
      const previous = source.corrects ? sources.find(item => item.id === source.corrects) : undefined;
      return <article className="source-turn" key={source.id}>
        <p className="metadata">{source.role === 'patient' ? patient ? 'Your message' : 'Patient answer' : patient ? 'Corvo Clinic asked' : 'Clinic question'} · {dateTime(source.at)}{source.channel === 'confirmed-transcript' && (patient ? ' · Spoken, checked by you' : ' · Reviewed transcript')}{source.channel === 'unreviewed-transcript' && (patient ? ' · Speech-to-text, not checked' : ' · Unreviewed recognized speech')}</p>
        <blockquote>{sourceSegments(source.text, source.id, provenance).map((segment, index) => segment.highlighted ? <mark key={index}>{segment.text}</mark> : segment.text)}</blockquote>
        {provenance?.some(span => span.sourceId === source.id) && <ul className="source-transform">{[...new Set(provenance.filter(span => span.sourceId === source.id).map(span => span.transform))].map(transform => <li key={transform}>{transformLabels[transform] ?? (patient ? 'Taken from the highlighted words' : 'Detail structured from the highlighted words')}</li>)}</ul>}
        {!patient && <p className="metadata source-id">Source {source.id}</p>}
        {source.corrects && <><p className="correction-label">Corrects an earlier answer</p>{previous ? <details><summary>See earlier answer</summary><p className="metadata">{dateTime(previous.at)}{!patient && ` · Source ${previous.id}`}</p><blockquote>{previous.text}</blockquote></details> : <p className="metadata">The earlier source is unavailable.</p>}</>}
      </article>;
    })}
    <p className="metadata source-footnote">{patient ? 'Saved as text. Audio isn’t kept here.' : 'Saved text record. Audio is not available in this view.'}</p>
  </section>;
}

/** Offline reference codes (SP-0.1): shown to staff only, never in place of the patient's words. */
const referenceSystems: Record<string, string> = { 'http://www.nlm.nih.gov/research/umls/rxnorm': 'RxNorm', 'http://hl7.org/fhir/sid/icd-10-cm': 'ICD-10-CM' };
const settledText = { 'will-provide': { patient: 'you’ll bring or check it', staff: 'patient will bring or check it' }, unknown: { patient: 'you weren’t sure', staff: 'patient doesn’t know' }, declined: { patient: 'you preferred not to say', staff: 'patient preferred not to say' } } as const;
const codeBasis = { exact: 'exact name match', synonym: 'listed synonym', 'patient-confirmed': 'spelling confirmed by patient' } as const;
/** Explicit, source-backed stop reasons. Avoidance is clinically meaningful, so staff see it plainly. */
const stopNotes: Partial<Record<NonNullable<TopicView['stopReason']>, { patient: string; staff: string }>> = {
  'patient-declines': { patient: 'You chose not to talk about this. Your care team will see that, and that’s okay.', staff: 'Patient preferred not to discuss this topic. Consider a gentle follow-up.' },
  'resistance-after-purpose': { patient: 'You chose not to talk about this. Your care team will see that, and that’s okay.', staff: 'Patient preferred not to continue after hearing why we ask. Consider a gentle follow-up.' },
  'patient-moves-on': { patient: 'You skipped this for now. You can add an answer anytime before sending.', staff: 'Patient skipped this topic for now.' },
  'safety-interruption': { patient: 'Paused for your safety.', staff: 'Stopped by a safety interruption.' },
};
export function TopicContent({ topic, onChange, onSource, disabled = false, audience = 'staff' }: {
  topic: TopicView; onChange?: (slotPath?: string) => void; onSource: (selection: SourceSelection, trigger: HTMLButtonElement) => void; disabled?: boolean; audience?: Audience;
}) {
  const patient = audience === 'patient';
  const stateLabels = patient ? patientAnswerLabels : answerLabels;
  const gapLabels = patient ? patientGapLabels : interpretationGapLabels;
  const detailStateLabel = (detail: NonNullable<TopicView['details']>[number]) => !detail.interpretation ? stateLabels[detail.state]
    : patient ? detail.state === 'answered' ? 'From your message' : `${stateLabels[detail.state]} · from your message`
    : `${answerLabels[detail.state]} · Proposed interpretation of your words`;
  const hasDetails = Boolean(topic.details?.length);
  const recorded = topic.details?.filter(detail => detail.state !== 'not-asked' || detail.text || detail.sourceIds.length) ?? [];
  const unasked = topic.details?.filter(detail => detail.state === 'not-asked' && !detail.text && !detail.sourceIds.length) ?? [];
  const untouchedMeasurements = topic.id === 'Q04' && recorded.length === 0 && unasked.length > 0;
  const renderDetail = (detail: NonNullable<TopicView['details']>[number]) => <div className="answer-detail" key={detail.id}>
    <dt>{detail.label}</dt><dd><p className="answer-label">{detailStateLabel(detail)}</p><p className="answer-text">{detailDisplayText(detail) || (patient ? 'Nothing recorded yet.' : 'No value recorded.')}</p>
    {detail.specificity?.needsDetail && <p className="detail-needs">{patient ? 'Still needed: ' : 'Needs detail: '}{detail.specificity.needsDetail}{detail.specificity.settled && ` (${settledText[detail.specificity.settled][patient ? 'patient' : 'staff']})`}</p>}
    {!patient && detail.specificity?.code && <p className="detail-code">{referenceSystems[detail.specificity.code.system] ?? detail.specificity.code.system} {detail.specificity.code.code} · {detail.specificity.code.display} · {codeBasis[detail.specificity.code.basis]}</p>}
    <div className="detail-actions">
      {onChange && detail.editable !== false && <Button variant="text" disabled={disabled} onClick={() => onChange(detail.id)}><Pencil size={14} aria-hidden="true" />Change<span className="sr-only"> {detail.label}</span></Button>}
      {detail.sourceIds.length > 0 && <Button variant="text" onClick={event => onSource({ topicId: topic.id, title: `${topic.title} · ${detail.label}`, ids: detail.sourceIds, provenance: detail.provenance }, event.currentTarget)}><FileText size={14} aria-hidden="true" />{patient ? 'Your words' : 'Source'}<span className="sr-only"> for {detail.label}</span></Button>}
      {detail.state === 'answered' && !detail.sourceIds.length && <span className="source-gap">{patient ? 'Your original words aren’t available' : 'Original answer unavailable'}</span>}
    </div></dd>
  </div>;
  return <>
    <div className="section-heading"><h3>{topic.title}</h3>{onChange && !hasDetails && topic.id !== 'interpretation' && <Button variant="text" disabled={disabled} onClick={() => onChange()}><Pencil size={15} aria-hidden="true" />Change<span className="sr-only"> {topic.title}</span></Button>}</div>
    {topic.screening && <section className="screening-result" aria-label={topic.screening.title}><h4>{topic.screening.title}</h4><p>{topic.screening.text}</p></section>}
    {topic.id === 'interpretation' ? <><p className="answer-label">{patient ? 'Not turned into answers yet · kept as you wrote it' : 'Interpretation incomplete · original words retained'}</p><p className="answer-text">{topic.answer?.text}</p><p>{patient ? 'The AI assistant couldn’t match some of your words to a question. This doesn’t mean you were unsure or skipped anything. Your care team will see your words as written.' : 'This describes a limitation of the interpreter. It does not mean the patient was unsure or chose not to answer.'}</p>{topic.interpretationGaps?.map(gap => <div className="answer-detail" key={gap.id}><p>{gapLabels[gap.reason]}</p><Button variant="text" onClick={event => onSource({ topicId: topic.id, title: gapLabels[gap.reason], ids: [...new Set(gap.evidence.map(span => span.sourceId))], provenance: gap.evidence.map(span => ({ ...span, transform: 'unmapped' })) }, event.currentTarget)}><FileText size={14} aria-hidden="true" />{patient ? 'See your words' : 'Inspect retained wording'}</Button></div>)}</> : !hasDetails ? <><p className="answer-label">{topic.answer ? stateLabels[topic.answer.state] : patient ? 'Not asked yet' : 'Not asked'}{topic.required && (patient ? ' · Needed for a complete intake' : ' · Required for complete intake')}</p><p className="answer-text">{topic.answer?.text || (patient ? 'No answer yet.' : 'No answer recorded.')}</p></> : <>
      {recorded.length > 0 ? <dl className="answer-details">{recorded.map(renderDetail)}</dl> : untouchedMeasurements ? <p className="measurement-gap-summary"><strong>{topic.required ? 'Required measurements are missing.' : 'Measurements are not recorded.'}</strong> Height with units, latest measured weight with units, and its measurement date have not been recorded.</p> : <p className="unasked-summary">No answers recorded for this topic yet.</p>}
      {unasked.length > 0 && <details className="unasked-details"><summary>{untouchedMeasurements ? `See all ${unasked.length} measurement details` : `${unasked.length} detail${unasked.length === 1 ? '' : 's'} not yet asked`}{onChange && unasked.some(detail => detail.editable !== false) ? ' · Add an answer' : ''}</summary><dl className="answer-details">{unasked.map(renderDetail)}</dl></details>}
    </>}
    {topic.stopReason && stopNotes[topic.stopReason] && <p className={`stop-note stop-note--${topic.stopReason}`}>{stopNotes[topic.stopReason]![patient ? 'patient' : 'staff']}</p>}
    {topic.missingDetails.length > 0 && <details className="detail-gaps"><summary>Still to clarify · {topic.missingDetails.length} detail{topic.missingDetails.length === 1 ? '' : 's'}</summary><ul>{topic.missingDetails.map((detail, index) => <li key={`${index}:${detail}`}>{detail}</li>)}</ul></details>}
    <div className="answer-footer"><span className={`topic-status topic-status--${topic.status}`}>{topicLabels[topic.status]}</span>{!hasDetails && topic.answer && <Button variant="text" onClick={event => onSource({ topicId: topic.id, title: topic.title, ids: topic.answer!.sourceIds }, event.currentTarget)}><FileText size={16} aria-hidden="true" />{patient ? 'See what you said' : `View original answer${topic.answer.sourceIds.length > 1 ? 's' : ''}`}</Button>}</div>
  </>;
}

export function EmptyQueue() {
  return <div className="queue-empty"><CheckCheck size={23} aria-hidden="true" /><h2>No assigned work yet</h2><p>Received work assigned to your team appears here. Saved confirmations that need delivery are listed separately below.</p></div>;
}
