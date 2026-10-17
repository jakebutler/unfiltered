import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderStaffWorkflowMetadata } from '../src/StaffApp';

describe('staff workflow context readback', () => {
  it('keeps source audit and the truncation marker in the collapsed workflow guidance', () => {
    const html = renderToStaticMarkup(renderStaffWorkflowMetadata({ handoff: { workflow: { completion: 'Synthetic care owner review.', contextRequirement: 'An exact authored plan.' }, contextSources: [{ kind: 'plan', reference: 'DocumentReference/plan-1', recordedAt: '2026-10-01T12:00:00.000Z', truncated: true }] } }));
    expect(html).toContain('<details');
    expect(html).not.toContain('open=');
    expect(html).toContain('Context used');
    expect(html).toContain('DocumentReference/plan-1');
    expect(html).toContain('(truncated)');
    expect(html).not.toContain('Synthetic exact authored plan text');
  });
  it('renders existing guidance with no fabricated source or truncation claim', () => {
    const html = renderToStaticMarkup(renderStaffWorkflowMetadata({ handoff: { workflow: { completion: 'Synthetic review.', contextRequirement: 'Missing plan.' } } }));
    expect(html).toContain('Missing plan.');
    expect(html).not.toContain('Context used');
    expect(html).not.toContain('(truncated)');
  });
});
