import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createClinicHandler } from '../../../packages/clinic-api/src/handler.js';
import type { ClinicApiConfig } from '../../../packages/clinic-api/src/types.js';
const path = resolve(process.env.CLINIC_CONFIG_PATH ?? 'infra/local/.clinic-config.json');
if (statSync(path).mode & 0o077)
    throw new Error('clinic-configuration-must-be-private');
const config = JSON.parse(readFileSync(path, 'utf8')) as ClinicApiConfig;
const handler = createClinicHandler(config);
const server = createServer(async (req, res) => { try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
        if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(',') : value);
    const request = new Request(`http://127.0.0.1:8787${req.url}`, { method: req.method, headers, ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}) } as RequestInit);
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body)
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(res);
    else
        res.end();
}
catch {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: { code: 'server-error', message: 'The request could not be completed.', retryable: true } }));
} });
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(8787, '127.0.0.1', () => console.log('Corvo Clinic API listening on http://127.0.0.1:8787 (synthetic local data only)'));
