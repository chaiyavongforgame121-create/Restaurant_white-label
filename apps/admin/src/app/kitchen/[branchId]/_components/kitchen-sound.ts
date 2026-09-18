/* The kitchen board's sounds.
 *
 * One AudioContext for the whole page. The board used to build a new context for every beep,
 * inside a realtime callback. Browsers create a context 'suspended' until the page has had a
 * user gesture, so after any reload the tablet stayed silent with no error and no hint, and every
 * beep leaked a context. Now the shared context is resumed on the first tap or key press (and by
 * the "Tap to enable order sounds" bar), and the view can read its state to show that bar.
 *
 * Which events can unlock it differs by device: a mouse's pointerdown carries the user activation,
 * a finger's does not (it arrives with pointerup / touchend, and iOS wants the resume inside
 * touchend or click). The view listens to all of them. */
export const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;

export type Chime = 'new' | 'reminder' | 'late' | 'test';

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;
let out: AudioNode | null = null;

/** The shared context, created on first use; null where Web Audio is missing. */
export function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  const Ctor: AudioCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    // A compressor in front of the speakers lets the chime be loud without clipping when two
    // tones overlap (an arrival and a reminder in the same second).
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 6;
    comp.ratio.value = 6;
    comp.connect(ctx.destination);
    out = comp;
  } catch {
    ctx = null;
    out = null;
  }
  return ctx;
}

export function audioRunning(): boolean {
  return audioContext()?.state === 'running';
}

/** How long unlockAudio() waits for resume(). A resume() the browser refuses (no user activation
 *  yet: a touch's pointerdown comes before the activation, which lands on pointerup / touchend)
 *  never settles; it is only fulfilled once a later, allowed resume() starts the context. */
const RESUME_WAIT_MS = 1_500;

/** Resume the context. Only works inside a user gesture (or once the page has had one). iOS also
 *  wants something started inside that gesture, before any await, so a one-sample silent buffer
 *  goes out first. Always settles: true when the context is running. */
export async function unlockAudio(): Promise<boolean> {
  const c = audioContext();
  if (!c) return false;
  if (c.state === 'running') return true;
  try {
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, 22_050);
    src.connect(c.destination);
    src.start(0);
    await Promise.race([c.resume(), new Promise((resolve) => window.setTimeout(resolve, RESUME_WAIT_MS))]);
  } catch {
    /* still locked; the bar stays up */
  }
  // resume() changed the state; TypeScript still narrows it from the check above.
  return (c.state as AudioContextState) === 'running';
}

function tone(c: AudioContext, dest: AudioNode, freq: number, at: number, dur: number, peak: number, type: OscillatorType) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(at);
  osc.stop(at + dur + 0.05);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

/** Play a chime. Returns false when the context is locked (nothing is heard). */
export function playChime(kind: Chime): boolean {
  const c = audioContext();
  if (!c || !out || c.state !== 'running') return false;
  const t0 = c.currentTime + 0.02;
  try {
    switch (kind) {
      case 'new':
      case 'test':
        // Bright rising two-tone, played twice: "ding-dong, ding-dong".
        tone(c, out, 880, t0, 0.24, 0.7, 'triangle');
        tone(c, out, 1319, t0 + 0.2, 0.36, 0.7, 'triangle');
        tone(c, out, 880, t0 + 0.65, 0.24, 0.7, 'triangle');
        tone(c, out, 1319, t0 + 0.85, 0.5, 0.7, 'triangle');
        break;
      case 'reminder':
        // The same two notes once: familiar, shorter.
        tone(c, out, 988, t0, 0.22, 0.6, 'triangle');
        tone(c, out, 1319, t0 + 0.18, 0.4, 0.6, 'triangle');
        break;
      case 'late':
        // Low, falling and buzzier, so it cannot be mistaken for a new order.
        tone(c, out, 587, t0, 0.28, 0.45, 'square');
        tone(c, out, 466, t0 + 0.32, 0.28, 0.45, 'square');
        tone(c, out, 392, t0 + 0.64, 0.5, 0.45, 'square');
        break;
    }
  } catch {
    return false;
  }
  return true;
}

/** BCP 47 tag for the board's UI locale, for speech. */
export function speechLang(locale: string): string {
  switch (locale) {
    case 'th':
      return 'th-TH';
    case 'es':
      return 'es-ES';
    case 'vi':
      return 'vi-VN';
    default:
      return 'en-US';
  }
}

export function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

/** Say a line in the board's language, with a voice for that language when the device has one. */
export function speak(text: string, lang: string): void {
  if (!speechAvailable()) return;
  try {
    const synth = window.speechSynthesis;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const prefix = lang.slice(0, 2).toLowerCase();
    const voice = synth.getVoices().find((v) => v.lang.replace('_', '-').toLowerCase().startsWith(prefix));
    if (voice) u.voice = voice;
    u.rate = 1;
    u.volume = 1;
    synth.speak(u);
  } catch {
    /* speech is a nicety; the chime already played */
  }
}
