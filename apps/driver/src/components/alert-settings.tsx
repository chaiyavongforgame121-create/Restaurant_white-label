'use client';

import * as React from 'react';
import { MonitorSmartphone, Volume2, VolumeX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn, playChime, setPlaybackAudioSession, unlockAudio } from '@favornoms/ui';
import { useDevicePref } from '@/lib/device-prefs';

/** How long the sample keeps iOS in media playback: the offer chime lasts about 1.1 s. */
const SAMPLE_PLAYBACK_MS = 2_000;

/** Called from the tap that turned sound on, so the browser lets it play: the rider hears what an
 *  offer will sound like (on an iPhone on silent too, as an offer will), and the same tap unlocks
 *  audio for the offers to come. */
function sampleOfferSound() {
  setPlaybackAudioSession(true);
  void unlockAudio().then((ok) => {
    if (ok) playChime('offer');
    window.setTimeout(() => setPlaybackAudioSession(false), SAMPLE_PLAYBACK_MS);
  });
}

/** The offer sound switch, as a small round button for the Home hero, opposite the battery. */
export function SoundQuickToggle({ className }: { className?: string }) {
  const t = useTranslations('home.sound');
  const [soundOn, setSoundOn] = useDevicePref('sound');
  const Icon = soundOn ? Volume2 : VolumeX;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={soundOn}
      aria-label={soundOn ? t('turnOff') : t('turnOn')}
      title={soundOn ? t('turnOff') : t('turnOn')}
      onClick={() => {
        const on = !soundOn;
        setSoundOn(on);
        if (on) sampleOfferSound();
      }}
      // An icon only, so it sits in the corner without crowding the greeting in any language;
      // min-h-0 opts out of the app-wide 48px button floor, as the battery pill opposite does.
      className={cn(
        'focus-ring grid h-9 min-h-0 w-9 place-items-center rounded-full ring-1 backdrop-blur',
        soundOn ? 'bg-white/15 text-white ring-white/20' : 'bg-black/40 text-white ring-warning/70',
        className,
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  );
}

/** The two alert switches for Profile, as list rows. */
export function AlertSettingRows() {
  const t = useTranslations('profile.alerts');
  const [soundOn, setSoundOn] = useDevicePref('sound');
  const [keepAwake, setKeepAwake] = useDevicePref('keepAwake');
  return (
    <>
      <li>
        <SwitchRow
          icon={soundOn ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
          title={t('sound')}
          detail={soundOn ? t('soundOn') : t('soundOff')}
          checked={soundOn}
          onChange={(on) => {
            setSoundOn(on);
            if (on) sampleOfferSound();
          }}
        />
      </li>
      <li>
        <SwitchRow
          icon={<MonitorSmartphone className="h-5 w-5" />}
          title={t('keepAwake')}
          detail={keepAwake ? t('keepAwakeOn') : t('keepAwakeOff')}
          checked={keepAwake}
          onChange={setKeepAwake}
        />
      </li>
    </>
  );
}

function SwitchRow({
  icon,
  title,
  detail,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="focus-ring flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-card p-4 text-left"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{title}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          'relative inline-flex h-7 w-12 shrink-0 rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-muted',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-6 w-6 rounded-full bg-white shadow-soft transition-transform',
            checked ? 'translate-x-[22px]' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
  );
}
