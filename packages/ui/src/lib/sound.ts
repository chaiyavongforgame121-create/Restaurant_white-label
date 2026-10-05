/* Sounds generated in code (no audio files): the kitchen board's order chimes, the back office
 * dashboard's "something new needs you" alert, and FavorGO's offer ring. They share this module
 * (and so one AudioContext per tab) rather than each carrying a copy, because every lesson below
 * was learned the hard way on the kitchen tablet and a second copy would have to learn them again.
 * It lived in apps/admin/src/lib/sound.ts until the rider app needed the same thing; the admin
 * path still re-exports it.
 *
 * One AudioContext for the whole page. The board used to build a new context for every beep,
 * inside a realtime callback. Browsers create a context 'suspended' until the page has had a
 * user gesture, so after any reload the tablet stayed silent with no error and no hint, and every
 * beep leaked a context. Now the shared context is resumed on the first tap or key press (and by
 * the "Tap to enable sound" bar), and the view can read its state to show that bar.
 *
 * Which events can unlock it differs by device: a mouse's pointerdown carries the user activation,
 * a finger's does not (it arrives with pointerup / touchend, and iOS wants the resume inside
 * touchend or click). The view listens to all of them. */
export const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;

/**
 * 'new' / 'reminder' / 'late' / 'test' are the kitchen's and the dashboard's.
 * 'offer' is a rider's incoming delivery offer: urgent, rung again every few seconds until the
 * rider answers. 'assigned' is a job handed to the rider outright: the friendly 'new' chime, once.
 */
export type Chime = 'new' | 'reminder' | 'late' | 'test' | 'offer' | 'assigned';

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

/** Whether the page has already had a tap or key press (sticky activation), so a context started
 *  now is allowed to run: true after a client-side navigation from a click, false on a fresh load.
 *  Unlike audioRunning() it never creates the AudioContext, so it is safe to ask before any gesture
 *  (Chrome logs a warning for every context created too early). False where the browser cannot
 *  say, and the caller then waits for a gesture of its own. */
export function hadUserGesture(): boolean {
  if (typeof navigator === 'undefined') return false;
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } })
    .userActivation;
  return activation?.hasBeenActive === true;
}

/**
 * Ask iOS to treat this page's sound as media playback (true) or hand the choice back to the
 * browser (false, 'auto'). Web Audio on an iPhone is otherwise ambient sound, which the ring/silent
 * switch mutes: a rider with the switch on silent would see an offer arrive without hearing it.
 * Safari's Audio Session API (iOS 17+) is the only lever; elsewhere `navigator.audioSession` does
 * not exist and this does nothing.
 *
 * Playback does not mix: it pauses whatever else the phone is playing. That is the point while an
 * offer that expires in a minute is ringing, and the wrong thing the rest of the time, so callers
 * switch it on for the urgent sound only and back off afterwards, rather than on every tap that
 * unlocks audio (which would stop the rider's music the moment they touched the app). Opt-in, so
 * the kitchen board and the dashboard keep their current behaviour. Returns whether the session
 * now has the type asked for.
 */
export function setPlaybackAudioSession(on: boolean): boolean {
  if (typeof navigator === 'undefined') return false;
  const session = (navigator as Navigator & { audioSession?: { type?: string } }).audioSession;
  if (!session) return false;
  const want = on ? 'playback' : 'auto';
  try {
    if (session.type !== want) session.type = want;
    return session.type === want;
  } catch {
    return false;
  }
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
      case 'assigned':
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
      case 'offer':
        // A phone ringing: a fast high trill, twice, about 1.1 s in all, so rung every three
        // seconds it leaves a gap to think in. Square waves carry over traffic and wind where
        // the kitchen's soft triangle chime would not; the compressor keeps them from clipping.
        for (const start of [t0, t0 + 0.6]) {
          tone(c, out, 1319, start, 0.11, 0.55, 'square');
          tone(c, out, 1760, start + 0.12, 0.11, 0.55, 'square');
          tone(c, out, 1319, start + 0.24, 0.11, 0.55, 'square');
          tone(c, out, 1760, start + 0.36, 0.16, 0.55, 'square');
        }
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
