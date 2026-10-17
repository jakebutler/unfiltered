#!/usr/bin/env node
// Builds the offline reference vocabularies for the SYNTHETIC clinic-intake demo (no patient text is ever sent anywhere).
//
// Committed sources only, chosen for a public repository:
//   - RxNorm Current Prescribable Content (NLM; "no license required; public domain"): ingredient (IN/PIN/MIN) and
//     brand (BN) names with brand → ingredient links. No drug classes (ATC is WHO-licensed; D6 needs none).
//   - CMS ICD-10-CM FY2027 code descriptions: validates the codes in our own authored condition terms
//     (packages/clinic-reference/authored/condition-terms.json) and supplies their short descriptions.
//
// Writes packages/clinic-reference/src/medications.generated.ts and conditions.generated.ts.
// Downloads are cached in .cache/reference/ (gitignored). Usage: node scripts/reference/build-reference.mjs
// Requires Node 20+ and the system `unzip`.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cache = path.join(root, '.cache', 'reference', 'downloads');
const out = path.join(root, 'packages', 'clinic-reference', 'src');
const rxnorm = { file: 'RxNorm_full_prescribe_10052026.zip', url: 'https://download.nlm.nih.gov/rxnorm/RxNorm_full_prescribe_10052026.zip', release: '2026-10-05' };
const icd = { file: '2027-code-descriptions-tabular-order.zip', url: 'https://www.cms.gov/files/zip/2027-code-descriptions-tabular-order.zip', entry: 'Code Descriptions/icd10cm_order_2027.txt', release: 'FY2027' };

async function download({ file, url }) {
  const target = path.join(cache, file);
  if (existsSync(target)) return target;
  await mkdir(cache, { recursive: true });
  const response = await fetch(url, { headers: { 'user-agent': 'unfiltered-clinic-reference-build/1.0 (synthetic demo)' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${target}.part`));
  await import('node:fs/promises').then(fs => fs.rename(`${target}.part`, target));
  return target;
}
async function* lines(zip, entry) {
  const child = spawn('unzip', ['-p', zip, entry], { stdio: ['ignore', 'pipe', 'inherit'] });
  const closed = new Promise((resolve, reject) => child.on('close', code => code === 0 ? resolve() : reject(new Error(`unzip ${entry} exited ${code}`))));
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) yield line;
  await closed;
}

// RxNorm: preferred unsuppressed RXNORM names for IN/PIN/MIN/BN, then BN → IN (tradename) or PIN (precise) links.
const zip = await download(rxnorm);
const names = new Map(); // rxcui -> { tty, name }
for await (const line of lines(zip, 'rrf/RXNCONSO.RRF')) {
  const f = line.split('|');
  if (f[11] !== 'RXNORM' || !['IN', 'PIN', 'MIN', 'BN'].includes(f[12]) || !['', 'N'].includes(f[16])) continue;
  const name = f[14].replace(/\s+/g, ' ').trim();
  if (!name || name.length > 120 || /[|\t\n]/.test(name)) continue;
  if (!names.has(f[0]) || f[6] === 'Y') names.set(f[0], { tty: f[12], name: f[12] === 'BN' ? name : name.toLowerCase() });
}
const links = new Map(); // brand rxcui -> { trade: Set, precise: Set }
for await (const line of lines(zip, 'rrf/RXNREL.RRF')) {
  const f = line.split('|');
  if (f[10] !== 'RXNORM') continue;
  const kind = ['has_tradename', 'tradename_of'].includes(f[7]) ? 'trade' : ['precise_ingredient_of', 'has_precise_ingredient'].includes(f[7]) ? 'precise' : undefined;
  if (!kind) continue;
  const [a, b] = [names.get(f[0]), names.get(f[4])];
  const [brand, ingredient] = a?.tty === 'BN' && b && b.tty !== 'BN' ? [f[0], f[4]] : b?.tty === 'BN' && a && a.tty !== 'BN' ? [f[4], f[0]] : [];
  if (!brand) continue;
  if (!links.has(brand)) links.set(brand, { trade: new Set(), precise: new Set() });
  links.get(brand)[kind].add(ingredient);
}
const rows = [];
for (const [rxcui, { tty, name }] of names) {
  if (tty !== 'BN') { rows.push([name, rxcui, tty, '']); continue; }
  const link = links.get(rxcui); if (!link) continue;
  rows.push([name, rxcui, tty, [...(link.trade.size ? link.trade : link.precise)].sort().join(',')]);
}
rows.sort((x, y) => x[0].toLowerCase() < y[0].toLowerCase() ? -1 : x[0].toLowerCase() > y[0].toLowerCase() ? 1 : x[1] < y[1] ? -1 : 1);

// ICD-10-CM: fixed-width order file (code cols 7-14, short description cols 17-77).
const codes = new Map();
for await (const line of lines(await download(icd), icd.entry)) {
  const code = line.slice(6, 14).trim(); if (code) codes.set(code, line.slice(16, 77).replace(/\s+/g, ' ').trim());
}
const authored = JSON.parse(readFileSync(path.join(root, 'packages', 'clinic-reference', 'authored', 'condition-terms.json'), 'utf8'));
const invalid = authored.terms.filter(term => !codes.has(term.icd10.replace('.', '')));
if (invalid.length) throw new Error(`ICD-10-CM codes not in ${icd.release}: ${invalid.map(term => `${term.name}=${term.icd10}`).join(', ')}`);
const conditions = authored.terms.map(term => ({ ...term, display: codes.get(term.icd10.replace('.', '')) }));

const header = (sources) => `// GENERATED by scripts/reference/build-reference.mjs. Do not edit. Sources: ${sources}.\n// This product uses publicly available data from the U.S. National Library of Medicine (NLM), National Institutes of Health,\n// Department of Health and Human Services; NLM is not responsible for the product and does not endorse or recommend this or any other product.\n`;
await writeFile(path.join(out, 'medications.generated.ts'), `${header(`RxNorm Current Prescribable Content ${rxnorm.release}`)}/** One row per line: name\\trxcui\\ttty\\tingredient rxcuis (brands only, comma-separated). */\nexport const medicationRelease = ${JSON.stringify(`rxnorm-prescribe-${rxnorm.release}`)};\nexport const medicationRows = ${JSON.stringify(rows.map(row => row.join('\t')).join('\n'))};\n`);
await writeFile(path.join(out, 'conditions.generated.ts'), `${header(`authored condition terms ${authored.version}; CMS ICD-10-CM ${icd.release}`)}export const conditionRelease = ${JSON.stringify(`${authored.version}+icd10cm-${icd.release}`)};\nexport const conditionTerms: readonly { name: string; synonyms: readonly string[]; icd10: string; display: string }[] = ${JSON.stringify(conditions.map(({ name, synonyms, icd10, display }) => ({ name, synonyms, icd10, display })), null, 1)};\n`);
console.log(JSON.stringify({ medications: rows.length, ingredients: rows.filter(row => row[2] !== 'BN').length, brands: rows.filter(row => row[2] === 'BN').length, conditions: conditions.length }));
