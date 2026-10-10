import { describe, expect, test, vi } from 'vitest';
import { requireFreeListener } from '../src/listener';

describe('native qualification listener ownership precondition', () => {
  test('only explicit connection refusal permits proceeding', async () => {
    const refused = new TypeError('synthetic fetch failure', { cause: { code: 'ECONNREFUSED' } });
    await expect(requireFreeListener(async () => { throw refused; })).resolves.toBeUndefined();
  });
  test.each(['ECONNRESET', 'ETIMEDOUT', undefined])('unknown fetch failure %s cannot become absence', async code => {
    const error = new TypeError('synthetic fetch failure', { cause: { code } });
    await expect(requireFreeListener(async () => { throw error; })).rejects.toBe(error);
  });
  test.each([200, 403, 500])('a reachable status %s is occupied and grants no ownership', async status => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = { status, body: { cancel } } as unknown as Response;
    await expect(requireFreeListener(async () => response)).rejects.toThrow('already occupied');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
