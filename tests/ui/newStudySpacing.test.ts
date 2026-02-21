import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const newStudyPagePath = path.resolve(__dirname, '../../app/studies/new/page.tsx');
const source = readFileSync(newStudyPagePath, 'utf8');

describe('New Study form spacing', () => {
  it('uses relaxed vertical rhythm for form sections', () => {
    expect(source).toContain('className="space-y-6"');
  });

  it('adds explicit label-to-field spacing wrappers', () => {
    const matches = source.match(/className="space-y-2"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });
});
