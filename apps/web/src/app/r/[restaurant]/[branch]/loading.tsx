/**
 * Every route under this segment is dynamic (resolveTenant reads cookies), so Next paints
 * this on every tap of the bottom tab bar. It used to be an eight-tile *menu* skeleton,
 * which meant opening an order flashed a grid of squares and then swapped to a completely
 * different layout. Two rules now: promise nothing about the shape of the page that is
 * coming, and stay invisible for the first 400 ms, so the navigations that resolve quickly
 * — nearly all of them — show no interstitial at all.
 */
export default function BranchLoading() {
  return (
    <div
      className="grid min-h-[60vh] animate-fade-in place-items-center"
      style={{ animationDelay: '400ms', animationFillMode: 'both' }}
    >
      <span
        role="status"
        aria-label="Loading"
        className="h-10 w-10 animate-spin rounded-full border-4 border-muted border-t-primary"
      />
    </div>
  );
}
