import { describe, expect, it } from 'vitest';
import { detectInstallPlatform } from './install-platform';

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  iphoneLine:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.9.0',
  iphoneWebView:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  ipadDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidSamsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  androidFacebook:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.0;]',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.68',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
};

describe('detectInstallPlatform', () => {
  it('sends iPhone Safari to Share › Add to Home Screen', () => {
    expect(detectInstallPlatform(UA.iphoneSafari, 5)).toBe('ios-safari');
  });

  it('tells other iPhone browsers apart from Safari', () => {
    expect(detectInstallPlatform(UA.iphoneChrome, 5)).toBe('ios-other-browser');
  });

  it('recognises in-app browsers, which cannot install anything', () => {
    expect(detectInstallPlatform(UA.iphoneLine, 5)).toBe('in-app-browser');
    expect(detectInstallPlatform(UA.iphoneWebView, 5)).toBe('in-app-browser');
    expect(detectInstallPlatform(UA.androidFacebook, 5)).toBe('in-app-browser');
    expect(detectInstallPlatform(UA.androidWebView, 5)).toBe('in-app-browser');
  });

  it('treats an iPad asking for the desktop site as an iPad, and a Mac as a Mac', () => {
    expect(detectInstallPlatform(UA.ipadDesktopMode, 5)).toBe('ios-safari');
    expect(detectInstallPlatform(UA.macSafari, 0)).toBe('desktop-safari');
  });

  it('groups every Android browser together', () => {
    expect(detectInstallPlatform(UA.androidChrome, 5)).toBe('android');
    expect(detectInstallPlatform(UA.androidSamsung, 5)).toBe('android');
  });

  it('separates Chromium, Safari and Firefox on computers', () => {
    expect(detectInstallPlatform(UA.windowsChrome)).toBe('desktop-chromium');
    expect(detectInstallPlatform(UA.windowsEdge)).toBe('desktop-chromium');
    expect(detectInstallPlatform(UA.macChrome)).toBe('desktop-chromium');
    expect(detectInstallPlatform(UA.windowsFirefox)).toBe('desktop-firefox');
  });

  it('falls back to unknown', () => {
    expect(detectInstallPlatform('')).toBe('unknown');
    expect(detectInstallPlatform('curl/8.0')).toBe('unknown');
  });
});
