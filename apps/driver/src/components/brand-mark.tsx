import * as React from 'react';

/**
 * The app's name as riders see it. public/manifest.webmanifest and public/sw.js are static files
 * that cannot import this, so they spell it out themselves; keep all three in step.
 */
export const APP_NAME = 'FavorGO';

// The car from public/icon.svg, in the same 512 box and facing right, so the mark inside the app
// is the one on the rider's home screen. The wheel arches are arcs in the outline and the side
// windows are evenodd holes, which keeps it one path that tints with currentColor and needs no
// mask ids (two masks with one id on a page would clip each other).
const BODY =
  'M112 328L112 292C112 276 122 268 138 266L160 262C170 222 186 184 208 168' +
  'C216 162 224 160 234 160L284 160C298 160 306 164 314 174L346 248' +
  'C350 255 354 258 362 259L382 262C400 265 412 276 412 294L412 328' +
  'C412 338 406 344 396 344L388 344A54 54 0 1 0 280 344L244 344A54 54 0 1 0 136 344' +
  'L128 344C118 344 112 338 112 328Z' +
  'M186 250C194 222 206 196 222 184C228 180 234 178 242 178L258 178L258 250Z' +
  'M274 178L292 178Q297 178 299 182L328 250L274 250Z';

const WHEEL_X = [190, 334] as const;
const WHEEL_Y = 342;

export interface FavorGoCarProps
  extends Omit<React.SVGProps<SVGSVGElement>, 'children' | 'viewBox'> {
  /**
   * `full` is the home-screen icon's car, speed lines and ringed wheels included. `compact` is the
   * favicon's cut for anything drawn smaller than about 32px, where both details blur to noise.
   */
  variant?: 'full' | 'compact';
}

/**
 * The FavorGO car glyph. It is wider than it is tall, so give it a box of roughly that shape
 * (for example `h-10 w-16` for `full`, `h-5 w-6` for `compact`) or it letterboxes inside a square.
 * Decorative by default; pass `role="img"` and an `aria-label` where it stands alone.
 */
export function FavorGoCar({ variant = 'full', ...props }: FavorGoCarProps) {
  const full = variant === 'full';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      // The car's own bounds plus 8 units of air; `full` reaches left to take in the speed lines.
      viewBox={full ? '24 152 396 242' : '104 152 316 242'}
      fill="currentColor"
      aria-hidden
      focusable="false"
      {...props}
    >
      <path fillRule="evenodd" d={BODY} />
      {WHEEL_X.map((x) =>
        full ? (
          <React.Fragment key={x}>
            <circle cx={x} cy={WHEEL_Y} r={34} fill="none" stroke="currentColor" strokeWidth={20} />
            <circle cx={x} cy={WHEEL_Y} r={11} />
          </React.Fragment>
        ) : (
          <circle key={x} cx={x} cy={WHEEL_Y} r={44} />
        ),
      )}
      {full && (
        <g fill="none" stroke="currentColor" strokeWidth={16} strokeLinecap="round">
          <path d="M60 226H88" opacity={0.7} />
          <path d="M40 262H88" />
          <path d="M60 298H88" opacity={0.7} />
        </g>
      )}
    </svg>
  );
}
