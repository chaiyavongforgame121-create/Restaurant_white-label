'use client';

import * as React from 'react';
import { hadUserGesture, playChime, UNLOCK_EVENTS, unlockAudio } from '@/lib/sound';
import {
  addFresh,
  detectArrivals,
  dropFresh,
  expireFresh,
  freshPerBucket,
  parseSeen,
  pruneFresh,
  serializeSeen,
  startFreshClocks,
  titleWithCount,
  type FreshMap,
  type SeenMemory,
  type WatchedBucket,
} from './alert-model';

/** One device-wide switch: an owner moving between branches wants the same answer on each. */
const SOUND_PREF_KEY = 'dashboard:sound';
const seenKey = (branchId: string) => `dashboard:seen:${branchId}`;
/** How often flags are checked for fading. Coarse on purpose: a fade is not a stopwatch. */
const FADE_CHECK_MS = 5_000;
const TOAST_MS = 8_000;
const PULSE_MS = 10_000;
/** Two arrivals a refresh apart ring once, not twice. */
const CHIME_GAP_MS = 5_000;
/** How late a chime owed from before the sound was unlocked may still be played. */
const CHIME_LATE_OK_MS = 3_000;

// Storage can be missing or throw (private mode, blocked site data). Every read falls back to
// "nothing stored" and every write is best-effort; the page works the same, it just forgets.
function readStore(store: 'local' | 'session', key: string): string | null {
  try {
    return (store === 'local' ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}
function writeStore(store: 'local' | 'session', key: string, value: string): void {
  try {
    (store === 'local' ? window.localStorage : window.sessionStorage).setItem(key, value);
  } catch {
    /* not persisted; this visit still behaves */
  }
}

export interface ArrivalToast {
  /** Bumped per arrival, so a second batch restarts the timer and re-announces. */
  id: number;
  count: number;
  buckets: string[];
}

export interface ActionAlerts {
  /** Scoped keys currently flagged new. */
  fresh: ReadonlySet<string>;
  freshByBucket: Record<string, number>;
  freshCount: number;
  /** True for a few seconds after an arrival: the header pulses. */
  pulsing: boolean;
  toast: ArrivalToast | null;
  dismissToast: () => void;
  markSeen: (keys: readonly string[]) => void;
  markAllSeen: () => void;
  sound: {
    on: boolean;
    /** Sound is on but the browser has not let it start yet: the page needs a tap first. */
    locked: boolean;
    toggle: () => void;
  };
}

/**
 * The live half of Action Required: which rows are new, the toast, the chime and the tab title.
 *
 * "New" means new to this tab. The first dashboard of a tab session is the baseline and announces
 * nothing; after that every snapshot (each refresh, live or timed, and each return to the page in
 * the same tab) is compared with what the tab has already seen, which is kept in sessionStorage
 * per branch so a reload does not announce the whole list again.
 */
export function useActionAlerts(branchId: string, watched: readonly WatchedBucket[]): ActionAlerts {
  const [fresh, setFresh] = React.useState<FreshMap>({});
  const [toast, setToast] = React.useState<ArrivalToast | null>(null);
  const [pulsing, setPulsing] = React.useState(false);
  const [soundOn, setSoundOn] = React.useState(true);
  // 'unknown' until the first check after mount, so the "click to allow sound" hint does not
  // flash up on a page that turns out to be allowed already.
  const [audioState, setAudioState] = React.useState<'unknown' | 'ready' | 'locked'>('unknown');

  const memoryRef = React.useRef<SeenMemory | null>(null);
  const loadedRef = React.useRef(false);
  const freshRef = React.useRef(fresh);
  freshRef.current = fresh;
  const soundOnRef = React.useRef(soundOn);
  soundOnRef.current = soundOn;
  const audioReadyRef = React.useRef(false);
  audioReadyRef.current = audioState === 'ready';
  const lastChimeAt = React.useRef(0);
  const chimeWaitingSince = React.useRef(0);
  const toastSeq = React.useRef(0);

  const persist = React.useCallback(
    (next: FreshMap) => {
      const memory = memoryRef.current;
      if (!memory) return;
      memoryRef.current = { ...memory, fresh: Object.keys(next) };
      writeStore('session', seenKey(branchId), serializeSeen(memoryRef.current));
    },
    [branchId],
  );

  const chime = React.useCallback(() => {
    // Only once a gesture has actually started the context. Asking playChime earlier would
    // create a context the browser refuses to run (and Chrome logs a warning for every one);
    // before that, the flag, the toast and the title carry the alert on their own.
    if (!soundOnRef.current) return;
    const now = Date.now();
    if (!audioReadyRef.current) {
      // Returning to the dashboard from another screen, the arrivals are read in the same
      // commit that unlocks the context; the unlock plays this if it lands within a moment.
      chimeWaitingSince.current = now;
      return;
    }
    if (now - lastChimeAt.current < CHIME_GAP_MS) return;
    // Still false if iOS has suspended the context since: nothing is heard, nothing breaks.
    if (playChime('reminder')) lastChimeAt.current = now;
  }, []);

  // The rows themselves change on every refresh; their keys are what this compares.
  const watchKey = JSON.stringify(watched);

  React.useEffect(() => {
    const current: WatchedBucket[] = JSON.parse(watchKey);
    const now = Date.now();
    const visible = document.visibilityState === 'visible';
    let base = freshRef.current;
    let prev = memoryRef.current;
    if (!loadedRef.current) {
      // First snapshot of this mount: what did this tab see last time it was here?
      loadedRef.current = true;
      prev = parseSeen(readStore('session', seenKey(branchId)));
      // Rows still flagged when the page was left come back flagged, but quietly: they were
      // announced once already.
      base = addFresh({}, prev?.fresh ?? [], now, visible);
    }
    const { arrived, buckets, memory } = detectArrivals(prev, current);
    memoryRef.current = memory;
    const next = addFresh(pruneFresh(base, current), arrived, now, visible);
    // Ahead of the state, so an effect that runs again before the next render (StrictMode
    // does exactly that on mount) builds on these flags instead of wiping them.
    freshRef.current = next;
    setFresh(next);
    persist(next);
    if (arrived.length > 0) {
      toastSeq.current += 1;
      setToast({ id: toastSeq.current, count: arrived.length, buckets });
      setPulsing(true);
      chime();
    }
  }, [watchKey, branchId, persist, chime]);

  // Fading. The clock only runs while the tab is visible (see FreshMap).
  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setFresh((f) => startFreshClocks(f, Date.now()));
    };
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setFresh((f) => expireFresh(f, Date.now()));
    }, FADE_CHECK_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Keep storage in step with fades as well as arrivals. Skipped while the state is behind the
  // ref (the render that carries the arrival effect's flags has not happened yet): writing the
  // older state would drop the flags a reload is meant to bring back.
  React.useEffect(() => {
    if (fresh === freshRef.current) persist(fresh);
  }, [fresh, persist]);

  React.useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(id);
  }, [toast]);

  React.useEffect(() => {
    if (!pulsing) return;
    const id = window.setTimeout(() => setPulsing(false), PULSE_MS);
    return () => window.clearTimeout(id);
  }, [pulsing, toast?.id]);

  // ── Sound ──────────────────────────────────────────────────────────────────
  // Read after mount, so the server render and the first client render agree.
  const [prefRead, setPrefRead] = React.useState(false);
  React.useEffect(() => {
    setSoundOn(readStore('local', SOUND_PREF_KEY) !== 'off');
    setPrefRead(true);
  }, []);

  // The shared AudioContext (lib/sound.ts) starts suspended until the page has had a tap or a
  // key press. Nothing here touches it before that: after a click-through from another screen
  // the page already has one (hadUserGesture), and otherwise the first gesture anywhere on the
  // page unlocks it. The listeners stay on because iOS suspends the context again after a call
  // or a sleep, and the next tap has to bring it back — the kitchen board's rule, for the same
  // reason. Muted, nothing is listened for and no context is ever created.
  React.useEffect(() => {
    // Not until the stored preference has been read: a muted device must never create one.
    if (!soundOn || !prefRead) return;
    let cancelled = false;
    const unlock = () => {
      void unlockAudio().then((ok) => {
        if (cancelled) return;
        audioReadyRef.current = ok;
        setAudioState(ok ? 'ready' : 'locked');
        const waiting = chimeWaitingSince.current;
        chimeWaitingSince.current = 0;
        // Only a chime owed from a moment ago: a tap a minute after an arrival is not the time
        // to ring for it.
        if (ok && waiting > 0 && Date.now() - waiting < CHIME_LATE_OK_MS) chime();
      });
    };
    if (hadUserGesture()) unlock();
    else setAudioState((s) => (s === 'ready' ? s : 'locked'));
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of UNLOCK_EVENTS) window.addEventListener(type, unlock, opts);
    return () => {
      cancelled = true;
      for (const type of UNLOCK_EVENTS) window.removeEventListener(type, unlock, opts);
    };
  }, [soundOn, prefRead, chime]);

  const toggleSound = React.useCallback(() => {
    const on = !soundOnRef.current;
    setSoundOn(on);
    writeStore('local', SOUND_PREF_KEY, on ? 'on' : 'off');
    // Called from a click, so the context may start here; the chime says what "on" sounds like.
    if (on) {
      void unlockAudio().then((ok) => {
        audioReadyRef.current = ok;
        setAudioState(ok ? 'ready' : 'locked');
        if (ok) playChime('reminder');
      });
    }
  }, []);

  // ── Tab title ──────────────────────────────────────────────────────────────
  const freshCount = Object.keys(fresh).length;
  React.useEffect(() => {
    const apply = () => {
      const want = titleWithCount(document.title, freshCount);
      if (document.title !== want) document.title = want;
    };
    apply();
    if (freshCount === 0) return;
    // Next writes the route's metadata title after hydration and on every refresh, which would
    // silently drop the count; put it back whenever the head changes (the kitchen board's fix).
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [freshCount]);
  React.useEffect(
    () => () => {
      document.title = titleWithCount(document.title, 0);
    },
    [],
  );

  const markSeen = React.useCallback(
    (keys: readonly string[]) => {
      const next = dropFresh(freshRef.current, keys);
      if (next === freshRef.current) return;
      // Written now, not in the effect: a click on a row is usually also a navigation, and the
      // page may be gone before an effect would run.
      persist(next);
      freshRef.current = next;
      setFresh(next);
    },
    [persist],
  );
  const markAllSeen = React.useCallback(() => {
    markSeen(Object.keys(freshRef.current));
    setToast(null);
  }, [markSeen]);
  const dismissToast = React.useCallback(() => setToast(null), []);

  const freshSet = React.useMemo(() => new Set(Object.keys(fresh)), [fresh]);
  const byBucket = React.useMemo(() => freshPerBucket(fresh), [fresh]);

  return {
    fresh: freshSet,
    freshByBucket: byBucket,
    freshCount,
    pulsing,
    toast,
    dismissToast,
    markSeen,
    markAllSeen,
    sound: { on: soundOn, locked: soundOn && audioState === 'locked', toggle: toggleSound },
  };
}
