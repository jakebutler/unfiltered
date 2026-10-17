import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { startResearchServer } from '../src/server';
import type { ResearchServerConfig } from '../src/config';

const state = vi.hoisted(() => ({ handler: undefined as any, server: undefined as any }));
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return { createServer: (_options: unknown, handler: unknown) => {
    const server = new EventEmitter() as any;
    server.listen = (_port: number, _host: string, ready: () => void) => ready();
    server.close = (done: () => void) => done(); server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
    state.handler = handler; state.server = server; return server;
  } };
});
vi.mock('../../../packages/research-capture/src/convex-authority', () => ({ convexCaptureAuthority: () => ({}) }));
vi.mock('../../../packages/research-capture/src/local-store', () => ({ LocalPrivateObjectStore: class {} }));
vi.mock('../../../packages/research-capture/src/gateway', () => ({ mediaGateway: () => async () => new Response(null, { status: 404 }) }));
vi.mock('../src/reports', () => ({ researchReportsGateway: () => async () => new Response(null, { status: 404 }) }));
vi.mock('../src/worker', () => ({ startCleanupWorker: () => ({ status: 'idle', stop: async () => {} }) }));
const config = { deployment: 'http://127.0.0.1:3210', publicOrigin: 'http://127.0.0.1:5174', bindOrigin: 'http://127.0.0.1:8789', gatewaySecret: 'a'.repeat(64), objectDirectory: '/unused-synthetic', maxSegmentBytes: 1024, cleanupIntervalMs: 2000 } as ResearchServerConfig;
function response() { const res = new EventEmitter() as any; res.writableFinished = false; res.destroyed = false; res.writeHead = vi.fn(); res.end = vi.fn(() => { res.writableFinished = true; }); res.destroy = vi.fn(); return res; }
test('default local server has no speech upgrade transport', async () => {
  const runtime = await startResearchServer(config); const socket = { destroy: vi.fn() };
  state.server.emit('upgrade', {}, socket, Buffer.alloc(0)); expect(socket.destroy).toHaveBeenCalledOnce(); await runtime.close();
});
test('opt-in mount preserves exact status facade admission and routes upgrades/shutdown', async () => {
  const speech = { handle: vi.fn(async () => new Response(null, { status: 200 })), upgrade: vi.fn(async () => {}), close: vi.fn() };
  const runtime = await startResearchServer(config, undefined, speech);
  const headers = { host: '127.0.0.1:8789', 'x-research-participant': 'a'.repeat(64), 'sec-fetch-site': 'same-origin', referer: 'http://127.0.0.1:5174/participate/synthetic-voice' };
  const req = Object.assign(new EventEmitter(), { url: '/api/research/speech/status', method: 'GET', headers }); const res = response();
  state.handler(req, res); await new Promise(resolve => setTimeout(resolve, 0));
  expect(speech.handle).toHaveBeenCalledOnce(); expect(res.writeHead.mock.calls[0][0]).toBe(200);
  expect((speech.handle.mock.calls[0] as any)[0].headers.get('Host')).toBe('127.0.0.1:8789');
  const rejected = response(); state.handler(Object.assign(new EventEmitter(), { url: req.url, method: 'GET', headers: { ...headers, referer: 'https://other.example/' } }), rejected);
  expect(rejected.writeHead.mock.calls[0][0]).toBe(403); expect(speech.handle).toHaveBeenCalledOnce();
  const socket = { destroy: vi.fn() }, upgrade = { url: '/api/research/speech/input', headers };
  state.server.emit('upgrade', upgrade, socket, Buffer.alloc(0)); expect(speech.upgrade).toHaveBeenCalledWith(upgrade, socket, Buffer.alloc(0));
  await runtime.close(); expect(speech.close).toHaveBeenCalledOnce();
});
