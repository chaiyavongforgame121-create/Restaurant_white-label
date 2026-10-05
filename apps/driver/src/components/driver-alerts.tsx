'use client';

import * as React from 'react';
import { Volume2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  UNLOCK_EVENTS,
  audioContext,
  hadUserGesture,
  playChime,
  setPlaybackAudioSession,
  unlockAudio,
} from '@favornoms/ui';
import {
  JOB_VIBRATE_PATTERN,
  OFFER_VIBRATE_PATTERN,
  jobIds,
  offerRingDue,
  offerShouldRing,
  sightJobs,
  wantsWakeLock,
} from '@/lib/alerts';
import { useDevicePref } from '@/lib/device-prefs';
import { useDriver } from '@/store/driver';
import { useDelivery } from './delivery-provider';
import { useDriverSession } from './driver-session';

type AudioState = 'unknown' | 'locked' | 'running' | 'unsupported';

/** How often the ring loop looks at the clock. The cadence itself is OFFER_RING_EVERY_MS; this
 *  only decides how soon a tap that unlocks sound, or an answer, is noticed. */
const RING_CHECK_MS = 500;
/** A tap on the strip that unlocks sound confirms it with a short chime, if it is this recent. */
const STRIP_CHIME_WINDOW_MS = 4_000;

function webAudioAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  return 'AudioContext' in window || 'webkitAudioContext' in window;
}

/**
 * navigator.vibrate where it exists and may run. iPhones have no vibrate API at all, and Chrome
 * refuses it (logging an intervention every time) until the page has had a tap, so on a fresh
 * launch this says false rather than calling it.
 */
function vibrate(pattern: number | readonly number[]): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } }).userActivation;
  if (activation && !activation.hasBeenActive) return false;
  try {
    return navigator.vibrate(typeof pattern === 'number' ? pattern : [...pattern]);
  } catch {
    return false;
  }
}

/**
 * Sound, vibration and the screen wake lock for FavorGO, in one place above every tab.
 *
 * - An offer rings an urgent chime about every three seconds, and vibrates, until the rider
 *   accepts or declines it or it expires. One buzz on arrival was the only alert before, and it
 *   was silent on every iPhone and on any Android that had not been tapped since launch.
 * - A job that lands without an offer (staff handing one over, a second stop added) rings once.
 * - Browsers keep sound off until the page has been touched, and iOS turns it off again after a
 *   call or a lock. Any tap anywhere turns it back on (the kitchen board's permanent listeners),
 *   and while it is off a strip across the top says so instead of the phone staying silently mute.
 * - While the rider is online the screen is kept awake: a locked phone drops the live connection,
 *   and with it every offer, until it is unlocked again.
 */
export function DriverAlerts() {
  const t = useTranslations('shell.sound');
  const { driver } = useDriverSession();
  const status = useDriver((s) => s.status);
  const { offered, offerDeadlineMs, responding, active, synced } = useDelivery();
  const [soundOn] = useDevicePref('sound');
  const [keepAwake] = useDevicePref('keepAwake');

  // The same "on shift" test as the location ping: the store for the optimistic flip, the
  // server's flag for a session restored on another screen.
  const online = status === 'online' || status === 'on_delivery' || !!driver.is_online;
  const onDelivery = !!active;

  const audioState = useAudioUnlock(soundOn);
  useOfferRing(offered?.id ?? null, offerDeadlineMs, responding, soundOn);
  useJobRing(synced, jobIds(offered).join(','), jobIds(active).join(','), soundOn);
  useScreenWakeLock(wantsWakeLock({ online, onDelivery, keepAwake }));

  // Only while something can actually ring: a strip on every screen of an offline rider who is
  // just checking their earnings would be noise.
  const showStrip = soundOn && audioState === 'locked' && (online || !!offered || onDelivery);
  if (!showStrip) return null;

  // No onClick: the tap itself is one of the window-level unlock gestures below, and the chime
  // that confirms it plays when the sound actually starts, whichever event started it.
  return (
    <button
      type="button"
      data-sound-unlock=""
      className="fixed inset-x-0 top-0 z-[130] flex w-full flex-wrap items-center justify-center gap-x-2 gap-y-0.5 bg-[#FFC53D] px-4 pb-2.5 pt-safe text-sm font-semibold text-[#4A3000] shadow-warm"
    >
      <Volume2 className="h-5 w-5" aria-hidden />
      {t('locked')}
      <span className="w-full text-center text-xs font-normal opacity-80">{t('lockedHint')}</span>
    </button>
  );
}

/**
 * The shared AudioContext (packages/ui lib/sound) starts suspended until the page has had a tap.
 * Nothing creates it before then unless the page already had one (a client-side navigation from
 * a tap), and every gesture after that tries again: iOS suspends it after a call, a lock or a trip
 * to another app, and the next tap must bring it back. Sound off: no listeners, no context.
 */
function useAudioUnlock(soundOn: boolean): AudioState {
  const [state, setState] = React.useState<AudioState>('unknown');

  React.useEffect(() => {
    if (!soundOn) return;
    if (!webAudioAvailable()) {
      setState('unsupported');
      return;
    }
    let cancelled = false;
    let bound: AudioContext | null = null;
    let stripTapAt = 0;

    const sync = () => {
      if (cancelled || !bound) return;
      const running = bound.state === 'running';
      setState(running ? 'running' : 'locked');
      if (running && stripTapAt > 0) {
        const fresh = Date.now() - stripTapAt < STRIP_CHIME_WINDOW_MS;
        stripTapAt = 0;
        if (fresh) playChime('reminder');
      }
    };
    const unlock = (event?: Event) => {
      if (bound && bound.state === 'running') return;
      if (event?.target instanceof Element && event.target.closest('[data-sound-unlock]')) {
        stripTapAt = Date.now();
      }
      void unlockAudio().then(() => {
        if (cancelled) return;
        const c = audioContext();
        if (c && c !== bound) {
          bound?.removeEventListener('statechange', sync);
          bound = c;
          c.addEventListener('statechange', sync);
        }
        sync();
      });
    };

    if (hadUserGesture()) unlock();
    else setState((s) => (s === 'running' ? s : 'locked'));
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of UNLOCK_EVENTS) window.addEventListener(type, unlock, opts);
    return () => {
      cancelled = true;
      for (const type of UNLOCK_EVENTS) window.removeEventListener(type, unlock, opts);
      bound?.removeEventListener('statechange', sync);
    };
  }, [soundOn]);

  return soundOn ? state : 'unknown';
}

/** Ring the offer on screen until offerShouldRing() says stop (lib/alerts). */
function useOfferRing(offerId: string | null, deadlineMs: number | null, responding: boolean, soundOn: boolean) {
  // Read through refs so an answer, an unlock or a mute is noticed on the next check rather than
  // restarting the loop (and its cadence) on every change.
  const deadlineRef = React.useRef(deadlineMs);
  deadlineRef.current = deadlineMs;
  const respondingRef = React.useRef(responding);
  respondingRef.current = responding;
  const soundRef = React.useRef(soundOn);
  soundRef.current = soundOn;

  React.useEffect(() => {
    if (!offerId) return;
    let lastRingAt: number | null = null;
    const tick = () => {
      const now = Date.now();
      const live = offerShouldRing({
        offerId,
        deadlineMs: deadlineRef.current,
        responding: respondingRef.current,
        now,
      });
      if (!live || !offerRingDue(lastRingAt, now)) return;
      // An iPhone on silent mutes Web Audio unless the page asks for media playback, which in
      // turn pauses the rider's music: worth it for an offer, so only while one rings (asked on
      // every ring, so turning sound on mid-offer, or a sample's reset, cannot leave it off).
      if (soundRef.current) setPlaybackAudioSession(true);
      const heard = soundRef.current && playChime('offer');
      const felt = vibrate(OFFER_VIBRATE_PATTERN);
      if (heard || felt) lastRingAt = now;
    };
    tick();
    const id = window.setInterval(tick, RING_CHECK_MS);
    return () => {
      window.clearInterval(id);
      vibrate(0);
      setPlaybackAudioSession(false);
    };
  }, [offerId]);

  // A tap on Accept or Decline stops a buzz already under way, not just the next one.
  React.useEffect(() => {
    if (responding) vibrate(0);
  }, [responding]);
}

/** Ring once when a job arrives without an offer (lib/alerts sightJobs). */
function useJobRing(synced: boolean, offerKey: string, activeKey: string, soundOn: boolean) {
  const seenRef = React.useRef<string[] | null>(null);
  const soundRef = React.useRef(soundOn);
  soundRef.current = soundOn;

  React.useEffect(() => {
    if (!synced) return;
    const split = (key: string) => (key ? key.split(',') : []);
    const { seen, ringJob } = sightJobs(seenRef.current, split(offerKey), split(activeKey));
    seenRef.current = seen;
    if (!ringJob) return;
    if (soundRef.current) playChime('assigned');
    vibrate(JOB_VIBRATE_PATTERN);
  }, [synced, offerKey, activeKey]);
}

/**
 * Hold a screen wake lock while `wanted`. The browser drops it whenever the page is hidden, so it
 * is taken again on every return to the foreground; some browsers refuse it before the page has
 * had a tap, so a tap retries too.
 */
function useScreenWakeLock(wanted: boolean) {
  React.useEffect(() => {
    if (!wanted || typeof navigator === 'undefined') return;
    type Sentinel = { released?: boolean; release: () => Promise<void> };
    const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<Sentinel> } })
      .wakeLock;
    if (!wakeLock) return;
    let lock: Sentinel | null = null;
    let disposed = false;
    let pending = false;
    const acquire = async () => {
      if (disposed || pending || document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      pending = true;
      try {
        const next = await wakeLock.request('screen');
        if (disposed) void next.release().catch(() => undefined);
        else lock = next;
      } catch {
        /* refused (battery saver, no tap yet, unsupported): the phone's own display settings apply */
      } finally {
        pending = false;
      }
    };
    const retry = () => void acquire();
    void acquire();
    document.addEventListener('visibilitychange', retry);
    window.addEventListener('pointerdown', retry, true);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', retry);
      window.removeEventListener('pointerdown', retry, true);
      if (lock) void lock.release().catch(() => undefined);
    };
  }, [wanted]);
}
