import { expect, test, vi } from 'vitest';
import { analysisReadinessGet } from '../src/FindingsWorkspace';

test('operator readiness explicitly retains a same-origin referrer under document no-referrer policy', async () => {
  const response = new Response('{}');
  const fetchRead = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  try {
    expect(await analysisReadinessGet('synthetic-operator-token')).toBe(response);
    expect(fetchRead).toHaveBeenCalledTimes(1);
    const [url, options] = fetchRead.mock.calls[0];
    expect(url).toBe('/api/research/analysis/readiness');
    const request = new Request(new URL(String(url), 'https://research.example'), options);
    expect(request.referrerPolicy).toBe('same-origin');
    expect(request.credentials).toBe('same-origin');
    expect(request.cache).toBe('no-store');
    expect(request.headers.get('Authorization')).toBe('Bearer synthetic-operator-token');
    expect(request.headers.has('Origin')).toBe(false);
    expect(request.headers.has('Referer')).toBe(false);
  } finally { fetchRead.mockRestore(); }
});
