/**
 * `url("…")` for an inline style. Unquoted, a URL holding a space, a quote or a bracket -- an
 * uploaded "photo (1).png" -- ends the value early and the picture silently does not load.
 */
export function cssUrl(url: string): string {
  return `url("${url.replace(/["\\\n\r]/g, (ch) => encodeURIComponent(ch))}")`;
}
