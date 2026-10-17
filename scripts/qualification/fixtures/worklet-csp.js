const button = document.querySelector('#run'), output = document.querySelector('#result');
const violations = [];
document.addEventListener('securitypolicyviolation', event => violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
button.addEventListener('click', async () => {
  button.disabled = true;
  output.textContent = 'Running synthetic capture under the packaged security policy…';
  const result = { fixture: 'packaged-worklet-csp', microphoneAccess: false, providerCalls: 0, workletLoaded: false, samples: 0, nonzero: false, flushed: false, contextClosed: false, cspViolations: violations };
  let context, oscillator, processor, silent, timer;
  try {
    context = new AudioContext(); await context.resume();
    await context.audioWorklet.addModule('/clinic-capture.worklet.js'); result.workletLoaded = true;
    oscillator = context.createOscillator(); oscillator.frequency.value = 440;
    processor = new AudioWorkletNode(context, 'clinic-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    silent = context.createGain(); silent.gain.value = 0;
    const flushed = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('worklet-flush-timeout')), 3000);
      processor.port.onmessage = event => {
        if (event.data instanceof Float32Array) { result.samples += event.data.length; result.nonzero ||= event.data.some(sample => Math.abs(sample) > .01); if (result.samples >= 8192) processor.port.postMessage('finish'); }
        else if (event.data?.type === 'flushed') { result.flushed = true; resolve(); }
      };
    });
    oscillator.connect(processor); processor.connect(silent); silent.connect(context.destination); oscillator.start();
    await flushed;
  } catch (error) { result.error = error instanceof Error ? error.message : 'worklet-failed'; }
  finally {
    clearTimeout(timer);
    if (processor) { processor.port.onmessage = null; processor.port.postMessage('stop'); processor.port.close(); processor.disconnect(); }
    if (oscillator) { try { oscillator.stop(); } catch {} oscillator.disconnect(); }
    silent?.disconnect();
    if (context) { await context.close(); result.contextClosed = context.state === 'closed'; }
    result.passed = !result.error && result.workletLoaded && result.samples > 0 && result.nonzero && result.flushed && result.contextClosed && !violations.length;
    output.textContent = JSON.stringify(result, null, 2);
  }
});
