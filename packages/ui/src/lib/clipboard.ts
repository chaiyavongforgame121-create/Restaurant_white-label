/**
 * Puts text on the clipboard, and says whether it worked.
 *
 * navigator.clipboard is missing on plain http (a LAN address during setup) and inside the
 * LINE / Facebook in-app browsers most riders open links in, and it can refuse without a
 * recent gesture — so this falls back to selecting the text and execCommand('copy').
 * `field` is a visible input or textarea already holding the text, which stays selected if
 * both routes fail; without one a hidden textarea stands in. Resolves false when nothing
 * worked, so the caller can point at the link to copy by hand instead of flashing "Copied".
 *
 * The same routine the staff invite panel grew (apps/admin …/staff-view.tsx), lifted here so
 * the admin and rider apps' "copy the FavorGO link" buttons behave alike.
 */
export async function copyText(
  text: string,
  field?: HTMLInputElement | HTMLTextAreaElement | null,
): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the selection route */
  }
  const previous = document.activeElement as HTMLElement | null;
  let stand: HTMLTextAreaElement | null = null;
  try {
    let target: HTMLInputElement | HTMLTextAreaElement | null = field ?? null;
    if (!target) {
      stand = document.createElement('textarea');
      stand.value = text;
      stand.setAttribute('readonly', '');
      stand.style.position = 'fixed';
      stand.style.top = '0';
      stand.style.opacity = '0';
      document.body.appendChild(stand);
      target = stand;
    }
    target.focus();
    target.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (stand) {
      stand.remove();
      // The stand-in took focus from the button; hand it back so keyboard users stay put.
      previous?.focus();
    }
  }
}
