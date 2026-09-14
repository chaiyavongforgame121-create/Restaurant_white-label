/**
 * Which "how do I install this?" instructions a visitor needs.
 *
 * The install rows in the customer and driver apps used to render only when Chrome had handed
 * over a `beforeinstallprompt` event (or on iPhone Safari). Chrome does not fire that event when
 * the app is already installed on the device, in most in-app browsers, in Firefox or Safari on a
 * computer, or before it has decided the page qualifies — so on most of the devices people
 * actually tried, the row was simply missing. The rows now always show, and when there is no
 * event to use they show the steps for the browser in hand, which is what this decides.
 *
 * Pure: takes the user agent and touch-point count rather than reading `navigator`, so it can be
 * tested and called during render.
 */
export type InstallPlatform =
  /** iPhone/iPad Safari: Share, then Add to Home Screen. */
  | 'ios-safari'
  /** Chrome, Firefox, Edge or Opera on iPhone/iPad: Share works on iOS 16.4+, else Safari. */
  | 'ios-other-browser'
  /** LINE, Facebook, Instagram, WeChat, TikTok, X, or an Android WebView: no install at all. */
  | 'in-app-browser'
  /** Any Android browser: the ⋮ menu has Install app / Add to Home screen. */
  | 'android'
  /** Chrome, Edge, Opera, Brave on a computer: address-bar icon or menu. */
  | 'desktop-chromium'
  /** Safari on a Mac: File › Add to Dock (Safari 17+). */
  | 'desktop-safari'
  /** Firefox on a computer: cannot install web apps. */
  | 'desktop-firefox'
  | 'unknown';

const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Twitter|TikTok|musical_ly|BytedanceWebview|; wv\)/i;
const IOS_OTHER_BROWSER = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\//i;

export function detectInstallPlatform(userAgent: string, maxTouchPoints = 0): InstallPlatform {
  const ua = userAgent || '';
  if (!ua) return 'unknown';
  if (IN_APP.test(ua)) return 'in-app-browser';

  // iPadOS 13+ Safari reports a Mac UA; touch points are what separate an iPad from a Mac.
  const isIos = /iPhone|iPod|iPad/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1);
  if (isIos) {
    if (IOS_OTHER_BROWSER.test(ua)) return 'ios-other-browser';
    // A WKWebView inside some app carries no "Safari/" token and has no Share sheet install.
    return /Safari\//i.test(ua) ? 'ios-safari' : 'in-app-browser';
  }

  if (/Android/i.test(ua)) return 'android';
  if (/Firefox\//i.test(ua)) return 'desktop-firefox';
  if (/Edg\/|OPR\/|Chrome\/|Chromium\//i.test(ua)) return 'desktop-chromium';
  if (/Macintosh/i.test(ua) && /Safari\//i.test(ua)) return 'desktop-safari';
  return 'unknown';
}
