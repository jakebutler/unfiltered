import { describe, expect, it } from 'vitest';
import { normalizeTtsProvider } from '@/lib/tts';
import {
  buildElevenLabsRequestConfig,
  normalizeVoiceStyleProfile,
  resolveVoiceSettingsForProfile,
} from '@/lib/elevenlabs';

describe('normalizeTtsProvider', () => {
  it('defaults to auto for empty values', () => {
    expect(normalizeTtsProvider(undefined)).toBe('auto');
    expect(normalizeTtsProvider('')).toBe('auto');
  });

  it('normalizes supported providers', () => {
    expect(normalizeTtsProvider('ELEVENLABS')).toBe('elevenlabs');
    expect(normalizeTtsProvider('browser')).toBe('browser');
    expect(normalizeTtsProvider(' auto ')).toBe('auto');
  });

  it('falls back to auto for unknown providers', () => {
    expect(normalizeTtsProvider('something-else')).toBe('auto');
  });
});

describe('buildElevenLabsRequestConfig', () => {
  it('builds request config with sane defaults and clamped settings', () => {
    const config = buildElevenLabsRequestConfig('Hello world', {
      ELEVENLABS_VOICE_ID: 'voice-123',
      ELEVENLABS_MODEL_ID: 'eleven_multilingual_v2',
      ELEVENLABS_OUTPUT_FORMAT: 'mp3_44100_128',
      ELEVENLABS_STABILITY: '1.5',
      ELEVENLABS_SIMILARITY_BOOST: '-0.5',
      ELEVENLABS_STYLE: '0.3',
      ELEVENLABS_USE_SPEAKER_BOOST: 'true',
    });

    expect(config.voiceId).toBe('voice-123');
    expect(config.modelId).toBe('eleven_multilingual_v2');
    expect(config.outputFormat).toBe('mp3_44100_128');
    expect(config.body.voice_settings.stability).toBe(1);
    expect(config.body.voice_settings.similarity_boost).toBe(0);
    expect(config.body.voice_settings.style).toBe(0.3);
    expect(config.body.voice_settings.use_speaker_boost).toBe(true);
  });

  it('applies style profile-specific voice settings', () => {
    const config = buildElevenLabsRequestConfig(
      'Walk me through what you expected to happen.',
      {
        ELEVENLABS_VOICE_ID: 'voice-123',
      },
      'empathy',
    );

    expect(config.body.voice_settings.style).toBeGreaterThan(0.3);
    expect(config.body.voice_settings.similarity_boost).toBeGreaterThanOrEqual(0.8);
  });
});

describe('normalizeVoiceStyleProfile', () => {
  it('normalizes valid style profile names', () => {
    expect(normalizeVoiceStyleProfile('INTRO')).toBe('intro');
    expect(normalizeVoiceStyleProfile(' followup ')).toBe('followup');
  });

  it('falls back to default for unknown profile names', () => {
    expect(normalizeVoiceStyleProfile('narrator')).toBe('default');
  });
});

describe('resolveVoiceSettingsForProfile', () => {
  it('returns distinct defaults for instruction vs followup', () => {
    const instruction = resolveVoiceSettingsForProfile('instruction', {
      ELEVENLABS_STABILITY: '0.45',
      ELEVENLABS_SIMILARITY_BOOST: '0.75',
      ELEVENLABS_STYLE: '0.2',
      ELEVENLABS_USE_SPEAKER_BOOST: 'true',
    });

    const followup = resolveVoiceSettingsForProfile('followup', {
      ELEVENLABS_STABILITY: '0.45',
      ELEVENLABS_SIMILARITY_BOOST: '0.75',
      ELEVENLABS_STYLE: '0.2',
      ELEVENLABS_USE_SPEAKER_BOOST: 'true',
    });

    expect(instruction.style).toBeLessThan(followup.style);
  });
});
