export class ActionObjectError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ActionObjectError'; }
}
/** JSON.parse cannot detect duplicate keys; validate every closed packet with this bounded parser. */
function uniqueJson(text: string): unknown {
  let position = 0;
  const fail = (): never => { throw new ActionObjectError('invalid-action-json'); };
  const space = () => { while (/^[ \r\n\t]$/.test(text[position] ?? '')) position++; };
  const string = (): string => {
    const start = position++; let escaped = false;
    while (position < text.length) {
      const char = text[position++];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') { try { return JSON.parse(text.slice(start, position)); } catch { return fail(); } }
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 32) throw new ActionObjectError('action-depth-limit');
    space(); const char = text[position];
    if (char === '"') return string();
    if (char === '{') {
      position++; space(); const result: Record<string, unknown> = Object.create(null), keys = new Set<string>();
      if (text[position] === '}') { position++; return result; }
      for (;;) {
        space(); if (text[position] !== '"') return fail();
        const key = string();
        if (keys.has(key)) throw new ActionObjectError('duplicate-action-key');
        keys.add(key); space(); if (text[position++] !== ':') return fail();
        result[key] = value(depth + 1); space(); const delimiter = text[position++];
        if (delimiter === '}') return result;
        if (delimiter !== ',') return fail();
      }
    }
    if (char === '[') {
      position++; space(); const result: unknown[] = [];
      if (text[position] === ']') { position++; return result; }
      for (;;) { result.push(value(depth + 1)); space(); const delimiter = text[position++]; if (delimiter === ']') return result; if (delimiter !== ',') return fail(); }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(position));
    if (!match) return fail(); position += match[0].length; return JSON.parse(match[0]);
  };
  const result = value(0); space(); if (position !== text.length) fail(); return result;
}
export type ActionObjectPacket = { kind: 'advance' | 'draft'; value: unknown };
/** Incremental lexical framing, not brace searching. Emits advance only after its complete JSON object. */
export class ActionFirstObjectDecoder {
  private text = ''; private position = 0;
  private stage: 'root' | 'key' | 'colon' | 'value' | 'separator' | 'close' | 'done' = 'root';
  private member: 'advance' | 'draft' = 'advance';
  private start?: number; private stack: string[] = []; private quoted = false; private escaped = false;
  constructor(private maximumBytes = 128000) {
    if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 128000) throw new ActionObjectError('invalid-action-byte-limit');
  }
  *feed(chunk: string): Generator<ActionObjectPacket> {
    this.text += chunk;
    if (new TextEncoder().encode(this.text).byteLength > this.maximumBytes) throw new ActionObjectError('action-object-too-large');
    while (this.position < this.text.length) {
      const char = this.text[this.position];
      if (this.stage !== 'value' && /^[ \r\n\t]$/.test(char)) { this.position++; continue; }
      if (this.stage === 'root') { if (char !== '{') throw new ActionObjectError('action-root-required'); this.position++; this.stage = 'key'; }
      else if (this.stage === 'key') {
        if (char !== '"') throw new ActionObjectError('action-member-order');
        let end = this.position + 1, escaped = false;
        for (; end < this.text.length; end++) { const next = this.text[end]; if (escaped) { escaped = false; continue; } if (next === '\\') escaped = true; else if (next === '"') break; }
        if (end === this.text.length) break;
        let key: unknown; try { key = JSON.parse(this.text.slice(this.position, end + 1)); } catch { throw new ActionObjectError('invalid-action-json'); }
        if (key !== this.member) throw new ActionObjectError('action-member-order');
        this.position = end + 1; this.stage = 'colon';
      } else if (this.stage === 'colon') { if (char !== ':') throw new ActionObjectError('invalid-action-json'); this.position++; this.stage = 'value'; }
      else if (this.stage === 'value') {
        if (this.start === undefined) {
          if (/^[ \r\n\t]$/.test(char)) { this.position++; continue; }
          if (char !== '{') throw new ActionObjectError('action-object-required');
          this.start = this.position;
        }
        if (this.quoted) {
          if (this.escaped) this.escaped = false;
          else if (char === '\\') this.escaped = true;
          else if (char === '"') this.quoted = false;
        } else if (char === '"') this.quoted = true;
        else if (char === '{' || char === '[') { this.stack.push(char); if (this.stack.length > 32) throw new ActionObjectError('action-depth-limit'); }
        else if (char === '}' || char === ']') {
          if (this.stack.pop() !== (char === '}' ? '{' : '[')) throw new ActionObjectError('invalid-action-json');
          if (!this.stack.length) {
            const value = uniqueJson(this.text.slice(this.start, this.position + 1));
            const kind = this.member; this.start = undefined;
            this.stage = this.member === 'advance' ? 'separator' : 'close';
            this.position++;
            yield { kind, value };
            continue;
          }
        }
        this.position++;
      } else if (this.stage === 'separator') { if (char !== ',') throw new ActionObjectError('action-draft-required'); this.position++; this.member = 'draft'; this.stage = 'key'; }
      else if (this.stage === 'close') { if (char !== '}') throw new ActionObjectError('unexpected-action-member'); this.position++; this.stage = 'done'; }
      else throw new ActionObjectError('action-trailing-data');
    }
  }
  finish() { if (this.stage !== 'done') throw new ActionObjectError('action-object-truncated'); }
}
