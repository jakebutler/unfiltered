import { describe, it, expect } from 'vitest';
import { generateMarkdownReport } from '@/lib/export/report';

const mockReport = {
  studyTitle: "Checkout Flow Test",
  sessionId: "abc123",
  endedAt: 1700000000000,
  themes: ["Users struggle to find checkout", "Form labels unclear"],
  sessionFriction: 72,
  moments: [
    {
      tStart: 45,
      tEnd: 75,
      taskId: "t1",
      taskLabel: "Complete checkout",
      frictionPeak: 85,
      candidateFindingLabel: "Checkout button not discoverable",
      category: "discoverability",
      interpretation: "User spent 30s searching for checkout.",
      recommendations: ["Make checkout CTA more prominent", "Use contrasting color"],
      signalTags: ["long_pause", "backtracking"],
      evidence: { transcriptSnippets: ["where is the checkout button"] },
    },
  ],
};

describe('generateMarkdownReport', () => {
  it('includes study title', () => {
    const md = generateMarkdownReport(mockReport);
    expect(md).toContain("Checkout Flow Test");
  });

  it('includes top themes', () => {
    const md = generateMarkdownReport(mockReport);
    expect(md).toContain("Users struggle to find checkout");
  });

  it('includes friction moment label', () => {
    const md = generateMarkdownReport(mockReport);
    expect(md).toContain("Checkout button not discoverable");
  });

  it('includes transcript quote', () => {
    const md = generateMarkdownReport(mockReport);
    expect(md).toContain("where is the checkout button");
  });
});
