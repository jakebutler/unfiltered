import { instrumentPrototype } from '../../../../../packages/research-capture/src/dom';
declare const __RESEARCH_ORIGIN__: string;
const origin = __RESEARCH_ORIGIN__;
if (location.origin === origin && window.opener) {
  let stop: (() => void) | null = null, challenge: string | null = null;
  const status = document.getElementById('status')!;
  window.addEventListener('message', event => {
    if (event.origin !== origin || event.source !== window.opener || !event.data || typeof event.data !== 'object') return;
    const data = event.data;
    if (data.type === 'corvo-dom-stop' && data.challenge === challenge) { stop?.(); stop = null; challenge = null; status.textContent = 'Disconnected'; return; }
    if (data.type !== 'corvo-dom-connect' || !/^[a-f0-9]{64}$/.test(data.challenge) || !Number.isSafeInteger(data.offsetMs) || !Number.isSafeInteger(data.startSequence) || challenge === data.challenge) return;
    stop?.();
    try { stop = instrumentPrototype({ receiver: window.opener, receiverOrigin: origin, challenge: data.challenge, offsetMs: data.offsetMs, startSequence: data.startSequence, components: new Map([[document.getElementById('component')!, 'c1']]) }); challenge = data.challenge; status.textContent = 'Connected'; }
    catch { status.textContent = 'Connection unavailable'; }
  });
  window.addEventListener('pagehide', () => { stop?.(); });
}
