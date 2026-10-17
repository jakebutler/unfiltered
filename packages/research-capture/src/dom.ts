import { CAPTURE_LIMITS, validateDomEvent, type DomEvent } from './contracts';
export type DomEnvelope = { version: 'corvo-dom-1'; challenge: string; event: DomEvent };
/** Runs in the controlled prototype. Call only after the participant explicitly
 * enabled DOM capture. Components are an application-owned opaque allowlist;
 * selectors, text, form values, attributes and location are never serialized. */
export function instrumentPrototype(options: { receiver: Window; receiverOrigin: string; challenge: string; components: ReadonlyMap<Element, string>; now?: () => number; offsetMs?: number; startSequence?: number }): () => void {
  const now = options.now ?? (() => performance.now()), started = now(), offset = options.offsetMs ?? 0; let sequence = options.startSequence ?? 0;
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= CAPTURE_LIMITS.domEvents) throw new Error("Invalid DOM sequence");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= CAPTURE_LIMITS.sessionMs) throw new Error("Invalid recording offset");
  if (new URL(options.receiverOrigin).origin !== options.receiverOrigin || !/^[a-f0-9]{64}$/.test(options.challenge) || options.components.size > 64 || [...options.components.values()].some(id => !/^c[0-9]{1,3}$/.test(id))) throw new Error('Invalid DOM configuration');
  const send = (event: Omit<DomEvent, 'sequence' | 'atMs'>) => {
    if (sequence >= CAPTURE_LIMITS.domEvents || now() - started + offset > CAPTURE_LIMITS.sessionMs) return;
    const value: DomEnvelope = { version: 'corvo-dom-1', challenge: options.challenge, event: { ...event, sequence: sequence++, atMs: Math.max(0, Math.round(now() - started + offset)) } };
    options.receiver.postMessage(value, options.receiverOrigin);
  };
  send({ kind: 'connected', target: 'none', tag: 'none', x: null, y: null });
  const handle = (event: Event) => {
    if (!(event.target instanceof Element)) return;
    let element: Element | null = event.target;
    while (element && !options.components.has(element)) element = element.parentElement;
    if (!element) return;
    // Password and content-editable fields never emit an event, even if misconfigured.
    if (event.target.closest('input[type=password],[contenteditable]')) return;
    const tag: DomEvent['tag'] = element.tagName === 'BUTTON' ? 'button' : element.tagName === 'A' ? 'link' : element.tagName === 'INPUT' ? 'input' : element.tagName === 'SELECT' ? 'select' : 'other';
    send({ kind: event.type === 'focusin' ? 'focus' : event.type as 'click' | 'change', target: options.components.get(element)!, tag, x: null, y: null });
  };
  for (const name of ['click', 'focusin', 'change']) document.addEventListener(name, handle);
  return () => { for (const name of ['click', 'focusin', 'change']) document.removeEventListener(name, handle); };
}
/** Parent interview bridge. The real browser MessageEvent origin/source must be
 * checked before forwarding; a payload's asserted origin is never trusted. */
export function acceptPrototypeMessage(event: MessageEvent, expected: { window: Window; origin: string; challenge: string }): DomEvent | null {
  if (event.source !== expected.window || event.origin !== expected.origin || !event.data || typeof event.data !== 'object') return null;
  const data = event.data as DomEnvelope;
  if (Object.keys(data).sort().join(',') !== 'challenge,event,version' || data.version !== 'corvo-dom-1' || data.challenge !== expected.challenge || !data.event || Object.keys(data.event).sort().join(',') !== 'atMs,kind,sequence,tag,target,x,y') return null;
  if (!['connected', 'click', 'focus', 'change', 'scroll'].includes(data.event.kind) || !['none', 'button', 'link', 'input', 'select', 'other'].includes(data.event.tag)) return null;
  try { validateDomEvent(data.event); return data.event; } catch { return null; }
}
