import { describe, expect, it } from 'vitest';
import { DRIVER_APP_FALLBACK_URL, driverAppUrl } from './driver-app-url';

describe('driverAppUrl', () => {
  it('falls back to the production rider app when nothing is configured', () => {
    expect(driverAppUrl(undefined)).toBe(DRIVER_APP_FALLBACK_URL);
    expect(driverAppUrl(null)).toBe(DRIVER_APP_FALLBACK_URL);
    expect(driverAppUrl('')).toBe(DRIVER_APP_FALLBACK_URL);
    expect(driverAppUrl('   ')).toBe(DRIVER_APP_FALLBACK_URL);
  });

  it('uses a configured https origin', () => {
    expect(driverAppUrl('https://go.favornoms.com')).toBe('https://go.favornoms.com');
    expect(driverAppUrl('  https://go.favornoms.com/  ')).toBe('https://go.favornoms.com');
  });

  it('keeps only the origin, so a pasted path, query or credential never reaches a code', () => {
    expect(driverAppUrl('https://go.favornoms.com/login?next=/app/home#x')).toBe(
      'https://go.favornoms.com',
    );
    expect(driverAppUrl('https://user:secret@go.favornoms.com/')).toBe('https://go.favornoms.com');
    expect(driverAppUrl('https://go.favornoms.com:8443/app')).toBe('https://go.favornoms.com:8443');
  });

  it('refuses anything that is not https', () => {
    expect(driverAppUrl('http://go.favornoms.com')).toBe(DRIVER_APP_FALLBACK_URL);
    expect(driverAppUrl('javascript:alert(1)')).toBe(DRIVER_APP_FALLBACK_URL);
    expect(driverAppUrl('ftp://go.favornoms.com')).toBe(DRIVER_APP_FALLBACK_URL);
  });

  it('refuses a value that is not a URL at all', () => {
    expect(driverAppUrl('go.favornoms.com')).toBe(DRIVER_APP_FALLBACK_URL);
    expect(driverAppUrl('not a url')).toBe(DRIVER_APP_FALLBACK_URL);
  });

  it('allows plain http only for a developer’s own machine', () => {
    expect(driverAppUrl('http://localhost:3001')).toBe('http://localhost:3001');
    expect(driverAppUrl('http://127.0.0.1:3001/')).toBe('http://127.0.0.1:3001');
    expect(driverAppUrl('http://[::1]:3001')).toBe('http://[::1]:3001');
    expect(driverAppUrl('http://driver.localhost:3001')).toBe('http://driver.localhost:3001');
    expect(driverAppUrl('http://localhost.evil.com')).toBe(DRIVER_APP_FALLBACK_URL);
    expect(driverAppUrl('http://evil-localhost')).toBe(DRIVER_APP_FALLBACK_URL);
  });
});
