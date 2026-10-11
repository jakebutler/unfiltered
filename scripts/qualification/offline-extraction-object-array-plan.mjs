/** Credential-free transport sketch. No fetch, environment loading, app imports or dispatch. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod/v4';

assert.equal(process.argv.length, 2, 'no live/credential arguments supported');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const packetPath = new URL('../../docs/implementation/evidence/S3-EXTRACTION-GROUPED-V2-AUTHORED-PACKET.json', import.meta.url);
const packetBytes = readFileSync(packetPath);
assert.equal(sha(packetBytes), 'ad7fa1ec22d4ae19285a72f87937ea3a8ec68a6f3603b35076a276594f032771');
assert.equal(sha(readFileSync(new URL('../../packages/clinical-core/src/digitalocean.ts', import.meta.url))), '0e40777c1c04ca3a4c8b3dee00240e5242ac4a1027028a89dd9257be2e47403e');
const packet = JSON.parse(packetBytes);
assert.deepEqual(packet.cases.map((c) => c.caseId), ['G3', 'P1', 'G7']);
const stateCodes = { known: 'k', narrow: 'r', negative: 'n', unknown: 'u', uncertain: 'q', declined: 'd', 'not-applicable': 'a' };
const stateNames = Object.fromEntries(Object.entries(stateCodes).map(([name, code]) => [code, name]));
const keys = (o, permitted) => {
  assert(o && typeof o === 'object' && !Array.isArray(o));
  assert(Object.keys(o).every((k) => permitted.includes(k)), 'unexpected input field');
};
const unique = (values) => assert.equal(new Set(values).size, values.length, 'duplicate destination');
function encodeRef(r) {
  if (typeof r === 'string') return r;
  if (Array.isArray(r)) { assert.equal(r.length, 3); return { s: r[0], a: r[1], b: r[2] }; }
  keys(r, ['e', 'p', 'v', 't', 'c']);
  return { e: r.e.map(encodeRef), p: encodeRef(r.p), v: r.v === null ? null : encodeRef(r.v), t: r.t, c: [...r.c] };
}
function decodeRef(r) {
  if (typeof r === 'string') return r;
  if ('s' in r) { assert(r.b > r.a, 'nonempty source span required'); return [r.s, r.a, r.b]; }
  return { e: r.e.map(decodeRef), p: decodeRef(r.p), v: r.v === null ? null : decodeRef(r.v), t: r.t, c: [...r.c] };
}
function encodeGroups(o) {
  return Object.entries(stateCodes).flatMap(([state, code]) => (o[state] ?? []).map(([s, fields]) => ({
    k: code, s: encodeRef(s), f: Object.keys(fields).map((key) => Array.isArray(fields) ? fields[key] : key),
    ...(['known', 'narrow'].includes(state) ? { v: Object.values(fields) } : {}),
  })));
}
function decodeGroups(g) {
  const result = {};
  for (const entry of g) {
    unique(entry.f);
    const state = stateNames[entry.k];
    let fields = [...entry.f];
    if ('v' in entry) {
      assert.equal(entry.f.length, entry.v.length, 'field/value cardinality mismatch');
      fields = Object.fromEntries(entry.f.map((field, i) => [field, entry.v[i]]));
    }
    (result[state] ??= []).push([decodeRef(entry.s), fields]);
  }
  return result;
}
function encodeItem(item) {
  keys(item, [...Object.keys(stateCodes), 'new', 'existing']);
  assert(Boolean(item.new) !== Boolean(item.existing), 'one identity required');
  return { n: item.new ? { s: item.new[0], e: item.new[1], r: encodeRef(item.new[2]) } : null, x: item.existing ?? null, g: encodeGroups(item) };
}
function encodeList(c, list) {
  keys(list, [...Object.keys(stateCodes), 'items', 'closed']);
  return { c, g: encodeGroups(list), i: (list.items ?? []).map(encodeItem), e: list.closed ? encodeRef(list.closed) : null };
}
function encode(wire) {
  keys(wire, ['m', 'topics', 'events', 'residual', 'disposition']);
  return { m: wire.m, t: Object.entries(wire.topics).map(([t, topic]) => {
    keys(topic, [...Object.keys(stateCodes), 'owner', 'lists']);
    return { t, o: Array.isArray(topic.owner) ? { s: 'other', e: topic.owner[1] } : topic.owner, g: encodeGroups(topic), l: Object.entries(topic.lists ?? {}).map(([c, list]) => encodeList(c, list)) };
  }), e: wire.events.map((event) => {
    keys(event, ['kind', 'topic', 'source', 'owner']);
    return { k: event.kind, t: event.topic, s: encodeRef(event.source), o: event.owner };
  }), r: wire.residual.map(([sources, reason]) => ({ s: sources.map(encodeRef), r: reason })), d: wire.disposition };
}
function schemaFor(m) {
  const bank = JSON.parse(m.messages[1].content).bank;
  const alias = z.enum(bank.map((s) => s.id));
  const ref = z.union([alias, z.strictObject({ s: alias, a: z.number().int().nonnegative(), b: z.number().int().positive() })]);
  const provenance = z.union([ref, z.strictObject({ e: z.array(ref).min(1).max(4), p: ref, v: ref.nullable(), t: z.string().min(1).max(300).nullable(), c: z.array(z.string().regex(/^p\d+$/)).max(8) })]);
  const names = z.array(z.string().min(1).max(300)).min(1).max(64);
  const scalar = z.union([z.string().min(1).max(8000), z.number().finite(), z.boolean(), z.strictObject({ feet: z.number().int().nonnegative(), inches: z.number().nonnegative().lt(12) })]);
  const group = z.union([
    z.strictObject({ k: z.literal('k'), s: provenance, f: names, v: z.array(scalar).min(1).max(64) }),
    z.strictObject({ k: z.literal('r'), s: provenance, f: names, v: z.array(z.string().min(1).max(8000)).min(1).max(64) }),
    z.strictObject({ k: z.enum(['n', 'u', 'q', 'd', 'a']), s: provenance, f: names }),
  ]);
  // Original limit is 64 entries PER state, not 64 entries across every state.
  const groups = z.array(group).max(448);
  const newIdentity = z.strictObject({ s: z.enum(['patient', 'other', 'unclear']), e: z.string().min(1).max(300), r: provenance });
  const item = z.strictObject({ n: newIdentity.nullable(), x: z.string().regex(/^i\d+$/).nullable(), g: groups });
  const list = z.strictObject({ c: z.string().min(1).max(300), g: groups, i: z.array(item).max(16), e: provenance.nullable() });
  const owner = z.union([z.enum(['patient', 'unclear']), z.strictObject({ s: z.literal('other'), e: z.string().min(1).max(300) })]);
  const topic = z.strictObject({ t: z.string().min(1).max(40), o: owner, g: groups, l: z.array(list) });
  return z.strictObject({ m: z.literal(m.id), t: z.array(topic), e: z.array(z.strictObject({ k: z.enum(['move-on', 'decline', 'question', 'treatment-question', 'dose-question']), t: z.string().min(1).max(40), s: ref, o: z.enum(['medical', 'nutrition', 'administrative']) })).max(4), r: z.array(z.strictObject({ s: z.array(ref).min(1).max(4), r: z.enum(['ambiguous', 'unsupported-target', 'capacity', 'conflict', 'recognition-unreviewed']) })).max(8), d: z.enum(['represented', 'partially-represented']) });
}
function decode(input, schema) {
  const wire = schema.parse(input);
  unique(wire.t.map((t) => t.t));
  const topics = Object.fromEntries(wire.t.map((topic) => {
    unique(topic.l.map((l) => l.c));
    const lists = Object.fromEntries(topic.l.map((list) => {
      const groups = decodeGroups(list.g);
      const items = list.i.map((item) => {
        assert(Boolean(item.n) !== Boolean(item.x), 'one identity required');
        return { ...decodeGroups(item.g), ...(item.n ? { new: [item.n.s, item.n.e, decodeRef(item.n.r)] } : { existing: item.x }) };
      });
      return [list.c, { ...groups, ...(items.length ? { items } : {}), ...(list.e ? { closed: decodeRef(list.e) } : {}) }];
    }));
    return [topic.t, { owner: typeof topic.o === 'string' ? topic.o : ['other', topic.o.e], ...decodeGroups(topic.g), ...(topic.l.length ? { lists } : {}) }];
  }));
  return { m: wire.m, topics, events: wire.e.map((e) => ({ kind: e.k, topic: e.t, source: decodeRef(e.s), owner: e.o })), residual: wire.r.map((r) => [r.s.map(decodeRef), r.r]), disposition: wire.d };
}
function inspectSchema(value) {
  if (!value || typeof value !== 'object') return;
  assert(!('allOf' in value) && !('propertyNames' in value) && !('prefixItems' in value), 'unqualified schema surface');
  assert(!Array.isArray(value.items), 'heterogeneous tuple');
  if (value.type === 'object') {
    assert.equal(value.additionalProperties, false, 'closed objects required');
    assert.deepEqual(new Set(value.required), new Set(Object.keys(value.properties)), 'every property required');
  }
  for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(inspectSchema); else inspectSchema(child);
}
let rejectionChecks = 0;
const rejects = (f) => { assert.throws(f); rejectionChecks++; };
const cases = packet.cases.map((c) => {
  const schema = schemaFor(c.renderedManifest), wire = encode(c.authored.wire);
  assert.deepEqual(decode(wire, schema), c.authored.wire);
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7', reused: 'ref' });
  inspectSchema(jsonSchema);
  const bytes = Buffer.byteLength(JSON.stringify(wire)), tokens = Math.ceil(bytes * .5);
  assert(tokens <= 400, 'stop before spend when preparation ceiling fails');
  const extra = structuredClone(wire); extra.extra = true; rejects(() => decode(extra, schema));
  const nested = structuredClone(wire); nested.t[0].extra = true; rejects(() => decode(nested, schema));
  const missing = structuredClone(wire); delete missing.t[0].g; rejects(() => decode(missing, schema));
  const duplicate = structuredClone(wire); duplicate.t.push(duplicate.t[0]); rejects(() => decode(duplicate, schema));
  return { caseId: c.caseId, originalGroupedBytes: Buffer.byteLength(JSON.stringify(c.authored.wire)), outputBytes: bytes, conservativeTokens: tokens, cap: 512, estimatedMarginTokens: 512 - tokens, schemaBytes: Buffer.byteLength(JSON.stringify(jsonSchema)), schemaSha256: sha(JSON.stringify(jsonSchema)), losslessAuthoredRoundtrip: true, wire, jsonSchema };
});
const g3 = cases[0], g3schema = schemaFor(packet.cases[0].renderedManifest);
const cardinality = structuredClone(g3.wire); cardinality.t[0].g[0].v.push('invented'); rejects(() => decode(cardinality, g3schema));
const duplicateField = structuredClone(g3.wire); duplicateField.t[0].g[0].f.push('day'); duplicateField.t[0].g[0].v.push('invented'); rejects(() => decode(duplicateField, g3schema));
const missingIdentity = structuredClone(g3.wire); missingIdentity.t[0].l[0].i[0].n = null; rejects(() => decode(missingIdentity, g3schema));
const bothIdentity = structuredClone(g3.wire); bothIdentity.t[0].l[0].i[0].x = 'i0'; rejects(() => decode(bothIdentity, g3schema));
const unissuedSource = structuredClone(g3.wire); unissuedSource.t[0].g[0].s = 's999'; rejects(() => decode(unissuedSource, g3schema));
const probe = structuredClone(packet.cases[0].authored.wire);
probe.topics.Q11.owner = ['other', 'parent'];
probe.topics.Q11.uncertain = [['s1', ['typicality']]];
probe.topics.Q11.declined = [['s1', ['day']]];
probe.topics.Q11['not-applicable'] = [['s1', ['otherIntake']]];
probe.events = [{ kind: 'question', topic: 'Q11', source: ['s0', 0, 1], owner: 'nutrition' }];
probe.residual = [[['s2'], 'ambiguous']];
assert.deepEqual(decode(encode(probe), g3schema), probe);
const span = encode(probe); span.e[0].s.b = 0; rejects(() => decode(span, g3schema));
console.log(JSON.stringify({ purpose: 'offline-lossless-object-array-sketch-only', providerCalls: 0, holdoutRead: false, activation: false, appCompilerReplayed: false, schemaCompatibilityObserved: false, exactTokenizerAvailable: false, authoredPacketSha256: sha(packetBytes), rejectionChecks, additionalRoundtrips: 1, cases }, null, 2));
