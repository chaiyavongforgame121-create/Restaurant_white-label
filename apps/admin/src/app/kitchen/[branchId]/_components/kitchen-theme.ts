/* ──────────────────────────────────────────────────────────────────────────
   "Sunset" theme — warm, light, gradient. Kept local to the kitchen surface so
   it never fights the global app theme. (Validated with the user 2026-06-17.)
   Shared by the board and the panels it opens.
   ──────────────────────────────────────────────────────────────────────── */
export const SUN = {
  page: '#FCF3EA',
  header: 'linear-gradient(120deg,#FF8A1E,#FF5C5C)',
  panel: 'rgba(255,255,255,.55)',
  card: '#FFFFFF',
  cardBorder: 'rgba(170,100,55,.13)',
  line: 'rgba(170,100,55,.10)',
  text: '#3E2A1E',
  muted: '#9C8470',
  faint: '#B8A593',
  qty: '#FF5E2C',
  accent: '#FF6B2C',
  accentBg: 'rgba(255,107,44,.14)',
  accentTx: '#BE4A12',
} as const;
