import { describe, expect, test } from 'vitest';
import { trustedFacadeOrigin } from '../src/origin';
import { mediaGateway, type CaptureAuthority } from '../../../packages/research-capture/src/gateway';
import type { PrivateObjectStore } from '../../../packages/research-capture/src/contracts';

const origin = 'http://127.0.0.1:5174';
const browser = { authorization: 'Bearer synthetic-invalid-token', 'sec-fetch-site': 'same-origin', referer: `${origin}/interview/example` };
describe('research authenticated GET facade origin', () => {
  test('only complete exact-origin browser metadata normalizes a GET with absent Origin', () => {
    expect(trustedFacadeOrigin('GET', browser, origin)).toBe(true);
    for (const headers of [
      { ...browser, authorization: undefined }, { ...browser, authorization: 'Basic token' },
      { ...browser, 'sec-fetch-site': undefined }, { ...browser, 'sec-fetch-site': 'cross-site' },
      { ...browser, referer: undefined }, { ...browser, referer: 'not a URL' },
      { ...browser, referer: 'http://127.0.0.1:51740/interview' }, { ...browser, referer: 'https://attacker.example/' },
    ]) expect(trustedFacadeOrigin('GET', headers, origin)).toBe(false);
    expect(trustedFacadeOrigin('PUT', browser, origin)).toBe(false);
    expect(trustedFacadeOrigin('POST', browser, origin)).toBe(false);
  });
  test('present Origin takes precedence and cannot use a metadata fallback', () => {
    expect(trustedFacadeOrigin('GET', { ...browser, origin }, origin)).toBe(true);
    expect(trustedFacadeOrigin('PUT', { origin }, origin)).toBe(true);
    for (const supplied of ['', 'http://127.0.0.1:9999', `${origin}/`, 'https://attacker.example']) expect(trustedFacadeOrigin('GET', { ...browser, origin: supplied }, origin)).toBe(false);
  });
  test('normalization grants no byte access: wrong bearer is still denied by the gateway authority', async () => {
    const calls: string[] = [];
    const denied = async (): Promise<never> => { throw new Error('Authority denied'); };
    const authority: CaptureAuthority = { claim: denied, inspect: denied, beginRetry: denied, activateRetry: denied, finalize: denied, cleanup: denied, deleted: denied,
      async read(bearer) { calls.push(bearer); return denied(); },
    };
    const store: PrivateObjectStore = { putIfAbsent: denied, head: denied, read: denied, retire: denied };
    expect(trustedFacadeOrigin('GET', browser, origin)).toBe(true);
    const response = await mediaGateway(store, authority, { origin })(new Request(`${origin}/api/research-media/synthetic`, { headers: { Origin: origin, Authorization: browser.authorization } }));
    expect(response.status).toBe(409); expect(calls).toEqual(['synthetic-invalid-token']);
    expect(await response.text()).toBe('Source unavailable; reconcile before retrying');
  });
});
