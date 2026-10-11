import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ParticipantApp } from '../src/ParticipantApp';
import { CaptureSources } from '../src/CaptureSources';

/** Actual mounted app/hooks/media; the local fixture only owns transport replies and synthetic input. */
export async function checkMountedResearchMechanics(container: HTMLElement, ports: { state: any; fixture: any; reset: (options?: any) => void; notify: () => void }) {
  const { state, fixture, reset, notify } = ports;
  const checks: any[] = []; let root: Root | null = null;
  const expect = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const wait = async (test: () => unknown, label: string, ms = 4000) => {
    const end = performance.now() + ms;
    while (!test()) { if (performance.now() > end) throw new Error(`${label}: ${container.textContent}`); await act(async () => { await new Promise(r => setTimeout(r, 25)); }); }
  };
  const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label);
  const click = async (label: string) => { const b = button(label); expect(b && !b.disabled, `Missing usable ${label}`); await act(async () => { b!.click(); }); };
  const text = async (value: string) => { const area = container.querySelector('textarea'); expect(area, 'Composer missing'); await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value); area!.dispatchEvent(new Event('input', { bubbles: true })); }); };
  const draft = () => container.querySelector('textarea')?.value;
  const count = (path: string) => state.requests.filter((r: any) => r.path === path).length;
  const unmount = async () => { if (root) { await act(async () => root!.unmount()); root = null; } };
  const mount = async (options: any = {}, player = false) => {
    await unmount(); sessionStorage.clear(); localStorage.clear(); reset(options); root = createRoot(container);
    await act(async () => root!.render(player ? <CaptureSources scope={{ clientId: 'fixture-client', projectId: 'fixture-project', sessionId: 'fixture-session' } as any} /> : <ParticipantApp fixture={fixture} />));
    await wait(() => player ? button('Open recording source') : button('Speak instead'), 'Mounted app');
  };
  const recognition = (socket: any, speechFinal = false) => socket.emit({ type: 'recognition', segment: { text: 'Synthetic spoken words', start: 0, duration: 0.3, isFinal: true, speechFinal } });
  try {
    await mount({ continuous: false, permission: 'deny' }); await text('Typed words remain'); await click('Speak instead'); await click('Start spoken draft');
    await wait(() => container.textContent?.includes('Microphone access was not allowed') && button('Start spoken draft'), 'Denied microphone');
    expect(draft() === 'Typed words remain' && state.sockets.length === 0 && count('/api/research/speech/commit') === 0, 'Permission denial changed wording or dispatched');
    await click('Type answers'); checks.push({ name: 'permission-denial', typedDraft: draft(), sockets: 0, commits: 0 });

    await mount({ permission: 'pending' }); await click('Speak instead'); await click('Talk through the interview'); await wait(() => state.permissionPending.length === 1, 'Pending permission');
    await click('Type answers'); await text('New typed wording'); await act(async () => { state.permissionPending.splice(0).forEach((r: any) => r()); });
    await wait(() => state.tracks.length && state.tracks.every((r: any) => r.track.readyState === 'ended'), 'Late permission cleanup');
    expect(draft() === 'New typed wording' && state.sockets.length === 0 && count('/api/research/speech/output') === 0, 'Late permission resumed voice');
    checks.push({ name: 'permission-after-mode-switch', ownedTracksEnded: true, outputRequests: 0 });

    await mount({ output: 'pending' }); await click('Speak instead'); await click('Talk through the interview'); await wait(() => state.outputPending.length === 1, 'Question output pending');
    await click('Type answers'); await text('Typed during pending audio'); await act(async () => { state.outputPending.splice(0).forEach((r: any) => r()); });
    await act(async () => { await new Promise(r => setTimeout(r, 200)); });
    expect(draft() === 'Typed during pending audio' && state.sockets.length === 0 && state.audios.every((a: HTMLAudioElement) => a.paused) && state.urls.size === 0, 'Late output resumed or leaked');
    expect(state.requests.find((r: any) => r.path.endsWith('/output')).signal.aborted, 'Question output was not aborted');
    checks.push({ name: 'late-question-output', draftPreserved: true, noAudibleResume: true, urls: 0 });

    await mount(); await click('Speak instead'); await click('Talk through the interview');
    await wait(() => state.audios.some((a: HTMLAudioElement) => !a.paused) && container.textContent?.includes('Question audio is playing') && button('Stop question audio'), 'Audible question before interruption');
    const interruptedAudio = state.audios.find((a: HTMLAudioElement) => !a.paused);
    await click('Stop question audio'); await wait(() => container.textContent?.includes('Speech microphone listening'), 'Interrupted question settled before listening');
    expect(interruptedAudio.paused && !interruptedAudio.getAttribute('src') && count('/api/research/speech/output') === 1 && count('/api/research/speech/settlement') === 1 && state.sockets.length === 1, 'Question interruption repeated audio or bypassed settlement');
    await click('Type answers'); expect(state.tracks.every((r: any) => r.track.readyState === 'ended') && state.urls.size === 0, 'Interrupted question cleanup leaked');
    checks.push({ name: 'audible-question-interruption', outputRequests: 1, settlementBeforeCapture: true, detached: true, released: true });

    await mount({ continuous: false, endOnFinish: false }); await click('Speak instead'); await click('Start spoken draft'); await wait(() => container.textContent?.includes('Speech microphone listening'), 'Actual worklet/socket ready');
    const old = state.sockets[0]; await act(async () => recognition(old)); await wait(() => draft() === 'Synthetic spoken words', 'Visible recognition');
    await click('Type answers'); await text('Replacement typed wording'); await act(async () => { state.session = { ...state.session, revision: 2, question: { id: 'q2', question: 'New current question?' } }; notify(); old.ended(); recognition(old); });
    await act(async () => { await new Promise(r => setTimeout(r, 100)); });
    expect(draft() === 'Replacement typed wording' && old.readyState === 3 && state.tracks.every((r: any) => r.track.readyState === 'ended') && count('/api/research/speech/commit') === 0, 'Stale receipt changed draft or saved');
    checks.push({ name: 'recognition-mode-scope-switch', oldSocketClosed: true, draftPreserved: true, commits: 0 });

    await mount({ continuous: false }); await click('Speak instead'); await click('Start spoken draft'); await wait(() => container.textContent?.includes('Speech microphone listening'), 'Listening before hide');
    const beforeHide = state.sockets.length;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); await act(async () => document.dispatchEvent(new Event('visibilitychange'))); Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await new Promise(r => setTimeout(r, 150)); });
    expect(state.sockets.length === beforeHide && state.sockets.every((s: any) => s.readyState === 3) && state.tracks.every((r: any) => r.track.readyState === 'ended'), 'Hidden tab resumed or leaked');
    checks.push({ name: 'hidden-tab', stopped: true, automaticRestart: false });

    await mount({ commit: 'unknown' }); await click('Speak instead'); await click('Talk through the interview'); await wait(() => container.textContent?.includes('Speech microphone listening'), 'Natural audio then capture', 6000);
    await act(async () => recognition(state.sockets[0], true)); await wait(() => button('Check saved spoken turn'), 'Unknown original commit');
    const original = state.requests.find((r: any) => r.path.endsWith('/commit')).body;
    await act(async () => { await new Promise(r => setTimeout(r, 250)); });
    expect(count('/api/research/speech/commit') === 1 && state.session.revision === 1 && state.sockets.every((s: any) => s.readyState === 3), 'Unknown save automatically repeated or advanced');
    state.options.commit = 'accepted'; await click('Check saved spoken turn'); await wait(() => state.session.revision === 2 && container.textContent?.includes('Next saved question?'), 'Original accepted receipt');
    const commits = state.requests.filter((r: any) => r.path.endsWith('/commit'));
    expect(commits.length === 2 && JSON.stringify(commits[1].body) === JSON.stringify(original) && state.sockets.length === 1 && count('/api/research/speech/output') === 1, 'Reconciliation replaced original or resumed transport');
    checks.push({ name: 'unknown-spoken-save', automaticRetries: 0, explicitExactOriginalChecks: 1, acceptedRevision: 2 });

    await mount({ commit: 'pending' }); await click('Speak instead'); await click('Talk through the interview');
    await wait(() => container.textContent?.includes('Speech microphone listening'), 'Capture before late acknowledgement', 6000);
    await act(async () => recognition(state.sockets[0], true)); await wait(() => state.commitPending.length === 1, 'Commit acknowledgement pending');
    await click('Type answers'); await text('Typed while original save is pending');
    await act(async () => { state.commitPending.splice(0).forEach((r: any) => r()); });
    await wait(() => state.session.revision === 2 && container.textContent?.includes('Next saved question?'), 'Late original acknowledgement readback');
    expect(draft() === 'Typed while original save is pending' && count('/api/research/speech/commit') === 1 && count('/api/research/speech/output') === 1 && state.sockets.length === 1 && state.tracks.every((r: any) => r.track.readyState === 'ended') && state.urls.size === 0, 'Late acknowledgement overwrote text or resumed speech');
    expect(container.textContent?.includes('current question changed while your draft was open'), 'New wording lacks old-question mismatch guidance');
    checks.push({ name: 'late-spoken-save-acknowledgement', draftPreserved: true, originalCommitRequests: 1, speechResumed: false });

    await mount({}, true); await click('Open recording source'); await wait(() => container.querySelector('video'), 'Complete private video body');
    const video = container.querySelector('video')!; await wait(() => video.readyState >= 1, 'Actual video metadata');
    expect(video.duration >= 7.5 && video.duration <= 8.5, 'Representative video duration wrong');
    await act(async () => { await video.play(); }); await wait(() => video.currentTime > 0.1, 'Playback advancing'); video.pause(); const paused = video.currentTime;
    await new Promise(r => setTimeout(r, 100)); expect(video.paused && Math.abs(video.currentTime - paused) < 0.05, 'Pause failed');
    video.playbackRate = 4; await video.play(); await wait(() => video.ended, 'Real decoded ended event', 4000);
    expect(!video.error, 'Media decoder failed'); const bytes = state.mediaBytes.length; await click('Close source'); expect(state.urls.size === 0 && !container.querySelector('video'), 'Closing video retained local object');
    checks.push({ name: 'representative-private-player', bytes, durationSeconds: video.duration, acceleratedPlayback: 4, ended: true, decoderError: null, released: true });
    for (const media of ['denied', 'truncated']) { await mount({ media }, true); await click('Open recording source'); await wait(() => container.textContent?.includes('could not be opened'), `${media} read rejected`); expect(!container.querySelector('video') && count('/capture/media/fixture-media') === 1 && state.urls.size === 0, `${media} read exposed video/retried`); checks.push({ name: `private-read-${media}`, video: false, automaticRetries: 0 }); }
    await mount({ media: 'stalled' }, true); await click('Open recording source'); await wait(() => button('Cancel opening'), 'Stalled read cancellation available'); await click('Cancel opening');
    await wait(() => button('Open recording source') && !button('Open recording source')!.disabled, 'Cancelled opening usable');
    expect(!container.querySelector('video') && state.urls.size === 0 && count('/capture/media/fixture-media') === 1, 'Cancel exposed source/retried');
    checks.push({ name: 'private-read-cancel', openingCleared: true, automaticRetries: 0 });
    return { passed: true, checks, mounted: true, externalDenied: state.externalDenied, providers: 0, cloud: 0, physicalMicrophone: false, autoplayQualified: false };
  } catch (error) { return { passed: false, checks, error: String(error), dom: container.textContent, requests: state.requests.map((r: any) => ({ path: r.path, method: r.method, body: r.body })), tracks: state.tracks.map((r: any) => ({ readyState: r.track.readyState, stops: r.stops })), sockets: state.sockets.map((s: any) => ({ readyState: s.readyState, bytes: s.bytes })) }; }
  finally { await unmount(); for (const row of state.tracks) if (row.track.readyState === 'live') row.track.stop(); }
}
