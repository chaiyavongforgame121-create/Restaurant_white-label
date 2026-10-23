import { useTranslations } from 'next-intl';

/**
 * The FavorNoms splash: the owner's chef-hat F and wordmark (public/brand/favornoms-splash.*)
 * centred on white, with three orange dots under it.
 *
 * Next shows it while the server work for a new root segment is pending: the first load of any
 * screen, signing in, and moving between the back office (/b), the POS (/counter), the kitchen
 * (/kitchen) and /platform. Moving between pages inside one of those keeps its layout and never
 * reaches this boundary, so the sidebar does not blink away on every click.
 *
 * White in dark mode too, on purpose. The art is an opaque raster drawn on white, not a
 * transparent logo, and "Favor" in the wordmark is near-black: on a dark page it would be a white
 * card with half the name lost around it. A full-screen white splash is how native apps open, and
 * the manifest's background_color is white, so an installed app's launch screen hands over to
 * this one without a flash of another colour.
 *
 * It paints only after 120 ms, so a navigation that resolves quickly shows nothing at all rather
 * than a white blink. The styles are inline, not Tailwind classes, so it looks the same wherever
 * it is mounted. `instant` skips that entrance, for a client screen that takes over from this one
 * while it is already showing.
 */
export default function AdminLoading({ instant = false }: { instant?: boolean }) {
  const t = useTranslations('common');
  return (
    <div role="status" className={instant ? 'fn-splash fn-splash--instant' : 'fn-splash'}>
      <style>{CSS}</style>
      {/* The PNG, not the WebP beside it: src/middleware.ts skips .png but not .webp, and for a
          signed-in user every request it does not skip waits on a Supabase getUser() round trip —
          the splash art would arrive after the page it was meant to cover. Add webp to that
          matcher and this can become a <picture> with the WebP first, as in apps/web. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- a fixed public file that has to paint without waiting on the image optimiser */}
      <img
        src="/brand/favornoms-splash.png"
        width={471}
        height={448}
        alt="FavorNoms"
        fetchPriority="high"
        className="fn-splash__art"
      />
      <span className="fn-splash__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="sr-only">{t('loading')}</span>
    </div>
  );
}

// The art is 471x448 px. Its width is about 64vw on a phone (220-280 px), up to 340 px on a tablet
// or desktop, never wider than its own pixels, and never taller than the screen allows (62vh of
// width is about 59vh of height).
const CSS = `
.fn-splash{position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:clamp(20px,4vh,36px);padding:max(24px,env(safe-area-inset-top)) 16px max(24px,env(safe-area-inset-bottom));background:#fff;color-scheme:light;animation:fn-splash-in .45s cubic-bezier(.16,1,.3,1) .12s both}
.fn-splash--instant,.fn-splash--instant .fn-splash__art{animation:none}
.fn-splash__art{display:block;width:clamp(220px,64vw,280px);max-width:min(100%,471px,62vh);height:auto;animation:fn-splash-art .6s cubic-bezier(.16,1,.3,1) .12s both}
@media (min-width:768px){.fn-splash__art{width:clamp(280px,30vw,340px)}}
.fn-splash__dots{display:flex;gap:9px}
.fn-splash__dots>span{width:9px;height:9px;border-radius:9999px;background:#FDA50F;animation:fn-splash-dot 1.2s ease-in-out infinite}
.fn-splash__dots>span:nth-child(2){background:#FC6C0F;animation-delay:.16s}
.fn-splash__dots>span:nth-child(3){background:#F2400A;animation-delay:.32s}
@keyframes fn-splash-in{from{opacity:0}to{opacity:1}}
@keyframes fn-splash-art{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}
@keyframes fn-splash-dot{0%,80%,100%{opacity:.35;transform:scale(.7)}40%{opacity:1;transform:scale(1)}}
@keyframes fn-splash-pulse{0%,100%{opacity:.35}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.fn-splash{animation-duration:.01s}.fn-splash__art{animation:none}.fn-splash__dots>span{animation-name:fn-splash-pulse;animation-duration:1.6s}}
`;
