import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isValidElement } from 'react';
import { ClientReportApp } from '../src/ClientReportApp';
const hooks = vi.hoisted(() => ({ index: 0, values: [] as any[] }));
vi.mock('react', async original => ({ ...await original<any>(),
  useState(initial: any) { const i = hooks.index++; if (!(i in hooks.values)) hooks.values[i] = initial; return [hooks.values[i], (value: any) => { hooks.values[i] = value; }]; },
  useRef(initial: any) { const i = hooks.index++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
  useEffect() {},
}));
function nodes(node: any): any[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!isValidElement(node)) return []; return [node, ...nodes((node.props as any).children)]; }
function view() { hooks.index = 0; return nodes(ClientReportApp()); }
const button = (label: string) => view().find(n => n.type === 'button' && n.props.children === label);
const hasEntry = () => view().some(n => n.type === 'h1' && n.props.children === 'Open your research report');
beforeEach(() => {
  hooks.values = [{ clientName: 'Synthetic client', projectName: 'Synthetic project', publishedAt: 0, version: 1, accessExpiresAt: Date.now()+60000, expiresAt: Date.now()+60000, evidence: [], grants: [] }, false];
  vi.stubGlobal('window', { location: { pathname: '/report/synthetic' } });
});
afterEach(() => vi.unstubAllGlobals());
it('does not show the password screen until the logout response is acknowledged', async () => {
  let reply!: (value: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { reply = resolve; })); vi.stubGlobal('fetch', fetcher);
  button('Sign out').props.onClick();
  expect(hasEntry()).toBe(false); expect(button('Signing out…').props.disabled).toBe(true);
  reply(new Response(null, { status: 204 }));
  await Promise.resolve(); await Promise.resolve();
  expect(hasEntry()).toBe(true); expect(fetcher).toHaveBeenCalledOnce();
});
it('keeps an explicit retry control after unconfirmed logout and never retries automatically', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 503 })); vi.stubGlobal('fetch', fetcher);
  button('Sign out').props.onClick();
  await Promise.resolve(); await Promise.resolve();
  expect(hasEntry()).toBe(false); expect(button('Sign out').props.disabled).toBe(false);
  expect(view().some(n => typeof n.props.children === 'string' && n.props.children.includes('Sign-out was not confirmed'))).toBe(true);
  expect(fetcher).toHaveBeenCalledOnce();
});
