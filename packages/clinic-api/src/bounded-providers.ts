import { createDigitalOceanProposer, buildAdaptiveMessages, AdaptiveProposalFailure, type AdaptiveProposer } from './adaptive.js';
import type { DigitalOceanConfig } from '../../clinical-core/src/digitalocean.js';
import type { Fetch } from '../../clinical-core/src/transport.js';
import type { SpeechAdmission } from '../../speech/src/server.js';
import { AdmissionError, noUnits, type ProviderLease, type ProviderReservation } from './provider-admission.js';
import { buildIntakeInterpreterMessages, createIntakeInterpreter, intakeRequestBytes, type IntakeInterpreter } from './intake-interpreter.js';

export interface ProviderAdmission { reserve(request: ProviderReservation): Promise<ProviderLease>; }
/** Credentials are server-only. Every call has both a durable spend claim and a single-flight draft claim. */
export function boundedAdaptiveProposer(config: Omit<DigitalOceanConfig, 'responseFormat'>, admission: ProviderAdmission, fetcher: Fetch = fetch, now = Date.now): AdaptiveProposer {
  if (config.timeoutMs > 12000) throw new AdmissionError('invalid-adaptive-provider-timeout');
  return { async propose(context) {
    const started = now();
    const messages = buildAdaptiveMessages(context);
    const inputBytes = messages.reduce((sum, message) => sum + new TextEncoder().encode(typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).byteLength, 0);
    if (inputBytes > 60000) throw new AdmissionError('adaptive-context-too-large');
    const lease = await admission.reserve({ provider: 'digitalocean', requestId: context.binding.operationId, sessionId: context.binding.sessionId, units: { ...noUnits(), requests: 1, inputBytes, outputTokens: config.maxOutputTokens } });
    // Usage is already durably reserved. Bookkeeping cannot hold a valid model result
    // past the application's deadline; an unacknowledged settlement retains its charge.
    let settled = false;
    const settle = (outcome: Parameters<ProviderLease['settle']>[0]) => {
      if (settled) return;
      settled = true;
      try { void Promise.resolve(lease.settle(outcome)).catch(() => undefined); } catch { /* Retain the full reservation. */ }
    };
    const remaining = Math.min(config.timeoutMs, 14000 - (now() - started));
    if (remaining < 100) { settle('failed'); throw new AdmissionError('provider-admission-timeout'); }
    try {
      const result = await createDigitalOceanProposer({ ...config, timeoutMs: remaining }, fetcher).propose(context);
      // A lost bookkeeping acknowledgement must never hide or repeat an actual provider result.
      settle('completed');
      return result;
    } catch (error) {
      settle(error instanceof AdaptiveProposalFailure ? 'completed' : 'unknown');
      throw error;
    }
  } };
}
/** Same durable spend claim as the legacy proposer, wrapped around one intake-interpreter-v1 call. */
export function boundedIntakeInterpreter(config: Omit<DigitalOceanConfig, 'responseFormat'>, admission: ProviderAdmission, fetcher: Fetch = fetch, now = Date.now): IntakeInterpreter {
  if (config.timeoutMs > 14000) throw new AdmissionError('invalid-adaptive-provider-timeout');
  return { async interpret(context, signal) {
    const started = now();
    const inputBytes = intakeRequestBytes(buildIntakeInterpreterMessages(context));
    const lease = await admission.reserve({ provider: 'digitalocean', requestId: context.binding.operationId, sessionId: context.binding.sessionId, units: { ...noUnits(), requests: 1, inputBytes, outputTokens: config.maxOutputTokens } });
    let settled = false;
    const settle = (outcome: Parameters<ProviderLease['settle']>[0]) => {
      if (settled) return;
      settled = true;
      try { void Promise.resolve(lease.settle(outcome)).catch(() => undefined); } catch { /* Retain the full reservation. */ }
    };
    const remaining = Math.min(config.timeoutMs, 14500 - (now() - started));
    if (remaining < 100) { settle('failed'); throw new AdmissionError('provider-admission-timeout'); }
    try {
      const result = await createIntakeInterpreter({ ...config, timeoutMs: remaining }, fetcher).interpret(context, signal);
      settle('completed');
      return result;
    } catch (error) {
      settle(error instanceof AdaptiveProposalFailure ? 'completed' : 'unknown');
      throw error;
    }
  } };
}
export function speechAdmission(admission: ProviderAdmission): SpeechAdmission {
  return { reserve(request) {
    return admission.reserve({ provider: request.provider, requestId: request.requestId, sessionId: request.sessionId, units: { ...noUnits(), requests: 1, characters: request.maxCharacters, audioSeconds: request.maxAudioSeconds } });
  } };
}
