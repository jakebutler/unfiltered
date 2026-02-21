import { describe, it, expect } from 'vitest';
import { normalizeTextForSpeech, pickPreferredVoice, runSequentially, splitSpeechIntoChunks } from '@/lib/tts';

type Voice = { name: string; lang: string; localService?: boolean; default?: boolean };

describe('pickPreferredVoice', () => {
  it('prioritizes an explicit preferred voice name', () => {
    const voices: Voice[] = [
      { name: 'Google US English', lang: 'en-US' },
      { name: 'Alloy Natural', lang: 'en-US' },
    ];

    const selected = pickPreferredVoice(voices as SpeechSynthesisVoice[], 'Google US English');
    expect(selected?.name).toBe('Google US English');
  });

  it('prefers natural sounding english voices before generic ones', () => {
    const voices: Voice[] = [
      { name: 'Microsoft David - English (United States)', lang: 'en-US' },
      { name: 'ElevenLabs Rachel Neural', lang: 'en-US' },
      { name: 'Samantha', lang: 'en-US' },
    ];

    const selected = pickPreferredVoice(voices as SpeechSynthesisVoice[]);
    expect(selected?.name).toBe('ElevenLabs Rachel Neural');
  });
});

describe('splitSpeechIntoChunks', () => {
  it('splits long prompts into short sentence chunks for smoother pacing', () => {
    const chunks = splitSpeechIntoChunks(
      'First sentence is short. Second sentence is a little longer and should remain intact for natural pacing. Third sentence should also be included cleanly.',
      80,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
    expect(chunks[0]).toContain('First sentence is short.');
  });
});

describe('normalizeTextForSpeech', () => {
  it('adds clearer pause boundaries for em dash transitions', () => {
    const normalized = normalizeTextForSpeech('Take your time—tell me what you expected.');
    expect(normalized).toBe('Take your time. Tell me what you expected.');
  });
});

describe('runSequentially', () => {
  it('runs async tasks with max concurrency of one', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const output = await runSequentially([1, 2, 3, 4], async (value) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return value * 2;
    });

    expect(output).toEqual([2, 4, 6, 8]);
    expect(maxInFlight).toBe(1);
  });
});
