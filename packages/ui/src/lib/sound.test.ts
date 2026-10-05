import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UNLOCK_EVENTS,
  audioContext,
  audioRunning,
  hadUserGesture,
  playChime,
  setPlaybackAudioSession,
  speechLang,
  unlockAudio,
} from './sound';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shared sound module', () => {
  it('listens for every event that can carry a tap’s user activation', () => {
    // A finger's activation lands on pointerup / touchend, not pointerdown.
    expect([...UNLOCK_EVENTS]).toEqual(['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']);
  });

  it('is inert where there is no browser (server render, tests)', async () => {
    expect(audioContext()).toBeNull();
    expect(audioRunning()).toBe(false);
    expect(hadUserGesture()).toBe(false);
    expect(playChime('offer')).toBe(false);
    expect(playChime('new')).toBe(false);
    expect(await unlockAudio()).toBe(false);
  });

  it('reads sticky activation without creating anything', () => {
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: true } });
    expect(hadUserGesture()).toBe(true);
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: false } });
    expect(hadUserGesture()).toBe(false);
  });

  it('asks iOS for media playback when the Audio Session API exists, and does nothing elsewhere', () => {
    const session = { type: 'auto' };
    vi.stubGlobal('navigator', { audioSession: session });
    expect(setPlaybackAudioSession(true)).toBe(true);
    expect(session.type).toBe('playback');
    // And hands it back once the urgent sound is over, so the rider's music is left alone.
    expect(setPlaybackAudioSession(false)).toBe(true);
    expect(session.type).toBe('auto');

    vi.stubGlobal('navigator', {});
    expect(setPlaybackAudioSession(true)).toBe(false);

    const refusing = {
      get type() {
        return 'auto';
      },
      set type(_value: string) {
        throw new Error('NotAllowedError');
      },
    };
    vi.stubGlobal('navigator', { audioSession: refusing });
    expect(setPlaybackAudioSession(true)).toBe(false);
  });

  it('maps the UI locale to a speech language', () => {
    expect(speechLang('th')).toBe('th-TH');
    expect(speechLang('es')).toBe('es-ES');
    expect(speechLang('vi')).toBe('vi-VN');
    expect(speechLang('en')).toBe('en-US');
    expect(speechLang('fr')).toBe('en-US');
  });
});
