import { useTranslations } from 'next-intl';

/**
 * The FavorGo splash: the owner's car-and-wordmark art (public/brand/favorgo-splash.*) centred on
 * white, with three orange dots under it.
 *
 * It is the app's boot screen: components/driver-session.tsx shows it while it signs the rider in
 * and reads their profile (1-3 s on a cold start of the installed app, or straight after sign-in).
 * It is not an app/loading.tsx on purpose: a root loading boundary streams every server redirect
 * (the one at '/', the sign-in ones) as a 200 with a client-side redirect, so the app would show
 * the splash, wait, and show it again.
 *
 * White in dark mode too, on purpose. The art is an opaque raster drawn on white, not a
 * transparent logo, and "Favor" in the wordmark is near-black: on a dark page it would be a white
 * card with half the name lost around it. A full-screen white splash is also how native apps open,
 * and the manifest's background_color is white, so Android's own launch screen hands over to this
 * one without a flash of another colour.
 *
 * It paints only after 120 ms, so a navigation that resolves quickly shows nothing at all rather
 * than a white blink. The styles are inline, not Tailwind classes, so it looks the same wherever
 * it is mounted. `instant` skips that entrance, for when it is the very first thing painted.
 */
export function FavorGoSplash({ instant = false }: { instant?: boolean }) {
  const t = useTranslations('common');
  return (
    <div role="status" className={instant ? 'fg-splash fg-splash--instant' : 'fg-splash'}>
      <style>{CSS}</style>
      <picture>
        <source srcSet="/brand/favorgo-splash.webp" type="image/webp" />
        {/* eslint-disable-next-line @next/next/no-img-element -- a fixed public file that has to paint without waiting on the image optimiser */}
        <img
          src="/brand/favorgo-splash.png"
          width={451}
          height={485}
          alt="FavorGo"
          fetchPriority="high"
          className="fg-splash__art"
        />
      </picture>
      <span className="fg-splash__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {/* The old loading screen said this out loud; keep saying it to screen readers. */}
      <span className="sr-only">{t('loading')}</span>
    </div>
  );
}

// The art is 451x485 px. Its width is about 64vw on a phone (220-280 px), up to 340 px on a tablet
// or desktop, never wider than its own pixels, and never taller than the screen allows (56vh of
// width is about 60vh of height).
const CSS = `
.fg-splash{position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:clamp(20px,4vh,36px);padding:max(24px,env(safe-area-inset-top)) 16px max(24px,env(safe-area-inset-bottom));background:#fff;color-scheme:light;animation:fg-splash-in .45s cubic-bezier(.16,1,.3,1) .12s both}
.fg-splash--instant,.fg-splash--instant .fg-splash__art{animation:none}
.fg-splash__art{display:block;width:clamp(220px,64vw,280px);max-width:min(100%,451px,56vh);height:auto;animation:fg-splash-art .6s cubic-bezier(.16,1,.3,1) .12s both}
@media (min-width:768px){.fg-splash__art{width:clamp(280px,30vw,340px)}}
.fg-splash__dots{display:flex;gap:9px}
.fg-splash__dots>span{width:9px;height:9px;border-radius:9999px;background:#FDA50F;animation:fg-splash-dot 1.2s ease-in-out infinite}
.fg-splash__dots>span:nth-child(2){background:#FC6C0F;animation-delay:.16s}
.fg-splash__dots>span:nth-child(3){background:#F2400A;animation-delay:.32s}
@keyframes fg-splash-in{from{opacity:0}to{opacity:1}}
@keyframes fg-splash-art{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}
@keyframes fg-splash-dot{0%,80%,100%{opacity:.35;transform:scale(.7)}40%{opacity:1;transform:scale(1)}}
@keyframes fg-splash-pulse{0%,100%{opacity:.35}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.fg-splash{animation-duration:.01s}.fg-splash__art{animation:none}.fg-splash__dots>span{animation-name:fg-splash-pulse;animation-duration:1.6s}}
`;
