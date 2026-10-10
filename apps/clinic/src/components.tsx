import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, CheckCheck, FileText, Pencil, ShieldCheck, X } from 'lucide-react';
import type { SourceTurn, StaffIdentity, TopicView } from '../../../packages/clinic-contract/src/index';

export const topicLabels: Record<TopicView['status'], string> = {
  'not-started': 'Not started', 'more-detail-needed': 'More detail needed',
  'ready-for-review': 'Ready for review', 'stopped-with-gaps': 'Stopped here · detail missing',
};
export const answerLabels = {
  answered: 'Patient reported', negative: 'Reported no', unknown: 'Not known',
  declined: 'Chose not to answer', uncertain: 'Not sure', 'not-asked': 'Not asked', conflicting: 'Needs clarification',
};
export const roleLabels: Record<StaffIdentity['role'], string> = {
  physician: 'Physician', 'nurse-practitioner': 'Nurse practitioner', 'physician-assistant': 'Physician assistant',
  'registered-dietitian': 'Registered dietitian', administrative: 'Administrative staff',
};
export const outcomeLabels = { received: 'Awaiting review', reviewed: 'Reviewed', 'needs-information': 'More information requested', declined: 'Declined', resolved: 'Outcome recorded' };
export const responsibilityLabels = { medical: 'Medical team', nutrition: 'Nutrition team', administrative: 'Administrative team' };

function formatDate(value: string | undefined, full: boolean) {
  if (!value || Number.isNaN(new Date(value).getTime())) return 'Not recorded';
  return new Intl.DateTimeFormat(undefined, full
    ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }
    : { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
export const time = (value?: string) => formatDate(value, false);
export const dateTime = (value?: string) => formatDate(value, true);

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
  return <><Header staff={staff} /><main id="main" className="loading-page" aria-busy="true"><p>Opening {staff ? 'your workspace' : 'Corvo Clinic'}…</p><div className="skeleton skeleton-title" /><div className="skeleton" /><div className="skeleton skeleton-short" /></main></>;
}
export type SourceSelection = { topicId: string; title: string; ids: string[] };

export function SourceInspector({ title, ids, sources, onClose }: { title: string; ids: string[]; sources: SourceTurn[]; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (ref.current?.getClientRects().length) ref.current.focus({ preventScroll: true });
  }, [title, ids.join(',')]);
  const selected = ids.map(id => sources.find(source => source.id === id)).filter((source): source is SourceTurn => Boolean(source));
  const missing = ids.length - selected.length;
  return <section ref={ref} tabIndex={-1} className="source-inspector" aria-label={`Original answers for ${title}`}>
    <div className="section-heading"><h3>Original answers</h3><Button variant="text" onClick={onClose} aria-label="Close original answers"><X size={18} aria-hidden="true" /></Button></div>
    <p className="source-topic">{title}</p>
    {(!selected.length || missing > 0) && <Notice tone="attention">{!selected.length ? 'No source answer is available for this detail.' : `${missing} referenced source answer${missing === 1 ? ' is' : 's are'} unavailable.`} This is a gap in the record.</Notice>}
    {selected.map(source => {
      const previous = source.corrects ? sources.find(item => item.id === source.corrects) : undefined;
      return <article className="source-turn" key={source.id}>
        <p className="metadata">{source.role === 'patient' ? 'Patient answer' : 'Clinic question'} · {dateTime(source.at)}</p>
        <blockquote>{source.text}</blockquote><p className="metadata source-id">Source {source.id}</p>
        {source.corrects && <><p className="correction-label">Corrects an earlier answer</p>{previous ? <details><summary>See earlier answer</summary><p className="metadata">{dateTime(previous.at)} · Source {previous.id}</p><blockquote>{previous.text}</blockquote></details> : <p className="metadata">The earlier source is unavailable.</p>}</>}
      </article>;
    })}
    <p className="metadata source-footnote">Saved text record. Audio is not available in this view.</p>
  </section>;
}

export function TopicContent({ topic, onChange, onSource, disabled = false }: {
  topic: TopicView; onChange?: (slotPath?: string) => void; onSource: (selection: SourceSelection, trigger: HTMLButtonElement) => void; disabled?: boolean;
}) {
  const hasDetails = Boolean(topic.details?.length);
  const recorded = topic.details?.filter(detail => detail.state !== 'not-asked' || detail.text || detail.sourceIds.length) ?? [];
  const unasked = topic.details?.filter(detail => detail.state === 'not-asked' && !detail.text && !detail.sourceIds.length) ?? [];
  const untouchedMeasurements = topic.id === 'Q04' && recorded.length === 0 && unasked.length > 0;
  const renderDetail = (detail: NonNullable<TopicView['details']>[number]) => <div className="answer-detail" key={detail.id}>
    <dt>{detail.label}</dt><dd><p className="answer-label">{answerLabels[detail.state]}</p><p className="answer-text">{detail.text || 'No value recorded.'}</p><div className="detail-actions">
      {onChange && detail.editable !== false && <Button variant="text" disabled={disabled} onClick={() => onChange(detail.id)}><Pencil size={14} aria-hidden="true" />Change<span className="sr-only"> {detail.label}</span></Button>}
      {detail.sourceIds.length > 0 && <Button variant="text" onClick={event => onSource({ topicId: topic.id, title: `${topic.title} · ${detail.label}`, ids: detail.sourceIds }, event.currentTarget)}><FileText size={14} aria-hidden="true" />Source<span className="sr-only"> for {detail.label}</span></Button>}
      {detail.state === 'answered' && !detail.sourceIds.length && <span className="source-gap">Original answer unavailable</span>}
    </div></dd>
  </div>;
  return <>
    <div className="section-heading"><h3>{topic.title}</h3>{onChange && !hasDetails && <Button variant="text" disabled={disabled} onClick={() => onChange()}><Pencil size={15} aria-hidden="true" />Change<span className="sr-only"> {topic.title}</span></Button>}</div>
    {topic.screening && <section className="screening-result" aria-label={topic.screening.title}><h4>{topic.screening.title}</h4><p>{topic.screening.text}</p></section>}
    {!hasDetails ? <><p className="answer-label">{topic.answer ? answerLabels[topic.answer.state] : 'Not asked'}{topic.required && ' · Required for complete intake'}</p><p className="answer-text">{topic.answer?.text || 'No answer recorded.'}</p></> : <>
      {recorded.length > 0 ? <dl className="answer-details">{recorded.map(renderDetail)}</dl> : untouchedMeasurements ? <p className="measurement-gap-summary"><strong>{topic.required ? 'Required measurements are missing.' : 'Measurements are not recorded.'}</strong> Height with units, latest measured weight with units, and its measurement date have not been recorded.</p> : <p className="unasked-summary">No answers recorded for this topic yet.</p>}
      {unasked.length > 0 && <details className="unasked-details"><summary>{untouchedMeasurements ? `See all ${unasked.length} measurement details` : `${unasked.length} detail${unasked.length === 1 ? '' : 's'} not yet asked`}{onChange && unasked.some(detail => detail.editable !== false) ? ' · Add an answer' : ''}</summary><dl className="answer-details">{unasked.map(renderDetail)}</dl></details>}
    </>}
    {topic.missingDetails.length > 0 && <details className="detail-gaps"><summary>Still to clarify · {topic.missingDetails.length} detail{topic.missingDetails.length === 1 ? '' : 's'}</summary><ul>{topic.missingDetails.map((detail, index) => <li key={`${index}:${detail}`}>{detail}</li>)}</ul></details>}
    <div className="answer-footer"><span className={`topic-status topic-status--${topic.status}`}>{topicLabels[topic.status]}</span>{!hasDetails && topic.answer && <Button variant="text" onClick={event => onSource({ topicId: topic.id, title: topic.title, ids: topic.answer!.sourceIds }, event.currentTarget)}><FileText size={16} aria-hidden="true" />View original answer{topic.answer.sourceIds.length > 1 ? 's' : ''}</Button>}</div>
  </>;
}

export function EmptyQueue() {
  return <div className="queue-empty"><CheckCheck size={23} aria-hidden="true" /><h2>No assigned work yet</h2><p>Confirmed handoffs appear here when they have been received and assigned to your team.</p></div>;
}
