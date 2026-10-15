import { describe, expect, it } from 'vitest';
import { defaultDestination, destinationFor, failureDestination, readEmailLink } from './email-link';

const ORIGIN = 'https://admin.favornoms.com';
const STAFF = '7724f5f4-52c2-400b-9538-b1aa900aaf71';

describe('readEmailLink', () => {
  it('reads the token, the type and the raw redirect pasted last', () => {
    const link = readEmailLink(
      `?token_hash=pkce_abc123&type=invite&next=https://admin.favornoms.com/auth/callback?next=%2Finvite%2Faccept%3Fstaff_id%3D${STAFF}`,
    );
    expect(link).toEqual({
      tokenHash: 'pkce_abc123',
      type: 'invite',
      redirectTo: `https://admin.favornoms.com/auth/callback?next=%2Finvite%2Faccept%3Fstaff_id%3D${STAFF}`,
    });
  });

  it('keeps a redirect that carries its own & intact', () => {
    expect(readEmailLink('token_hash=x&type=recovery&next=https://a.test/p?one=1&two=2').redirectTo).toBe(
      'https://a.test/p?one=1&two=2',
    );
  });

  it('decodes a redirect pasted percent-encoded, once', () => {
    expect(readEmailLink('token_hash=x&type=magiclink&next=https%3A%2F%2Fadmin.favornoms.com%2Fb%2F1%3Fq%3D%2525').redirectTo).toBe(
      'https://admin.favornoms.com/b/1?q=%25',
    );
  });

  it('rejects an unknown type and an empty token', () => {
    expect(readEmailLink('token_hash=&type=invite').tokenHash).toBeNull();
    expect(readEmailLink('token_hash=x&type=admin').type).toBeNull();
    expect(readEmailLink('token_hash=x&type=recovery').redirectTo).toBeNull();
  });
});

describe('destinationFor', () => {
  it('follows the next of an /auth/callback redirect', () => {
    expect(
      destinationFor(`https://admin.favornoms.com/auth/callback?next=%2Finvite%2Faccept%3Fstaff_id%3D${STAFF}`, 'invite', ORIGIN),
    ).toBe(`/invite/accept?staff_id=${STAFF}`);
    expect(destinationFor('https://admin.favornoms.com/auth/callback?next=%2Fauth%2Fupdate-password', 'recovery', ORIGIN)).toBe(
      '/auth/update-password',
    );
  });

  it('keeps only the path of a redirect on another host (old vercel.app, the Site URL)', () => {
    expect(
      destinationFor('https://restaurant-white-label-admin.vercel.app/auth/callback?next=%2Fonboarding', 'email', ORIGIN),
    ).toBe('/onboarding');
    expect(destinationFor('https://app.favornoms.com', 'recovery', ORIGIN)).toBe('/auth/update-password');
    expect(destinationFor('https://app.favornoms.com/', 'invite', ORIGIN)).toBe('/');
  });

  it('never leaves the app', () => {
    expect(destinationFor('https://admin.favornoms.com/auth/callback?next=https://evil.example', 'magiclink', ORIGIN)).toBe('/');
    expect(destinationFor('https://admin.favornoms.com/auth/callback?next=//evil.example', 'recovery', ORIGIN)).toBe(
      '/auth/update-password',
    );
    expect(destinationFor('https://admin.favornoms.com/auth/callback?next=/%5Cevil.example', 'magiclink', ORIGIN)).toBe('/');
    expect(destinationFor('not a url at all', 'signup', ORIGIN)).toBe('/onboarding');
    expect(destinationFor(null, 'invite', ORIGIN)).toBe('/');
  });
});

describe('defaultDestination / failureDestination', () => {
  it('sends each type somewhere useful by default', () => {
    expect(defaultDestination('recovery')).toBe('/auth/update-password');
    expect(defaultDestination('signup')).toBe('/onboarding');
    expect(defaultDestination('email')).toBe('/onboarding');
    expect(defaultDestination('magiclink')).toBe('/');
    expect(defaultDestination(null)).toBe('/');
  });

  it('returns an invitation to its own page, marked expired', () => {
    expect(failureDestination(`/invite/accept?staff_id=${STAFF}`, ORIGIN)).toBe(`/invite/accept?staff_id=${STAFF}&link=expired`);
  });

  it('sends anything else to sign-in with the expired message, keeping where it was going', () => {
    expect(failureDestination('/auth/update-password', ORIGIN)).toBe('/login?error=otp_expired&next=%2Fauth%2Fupdate-password');
    expect(failureDestination('/', ORIGIN)).toBe('/login?error=otp_expired');
  });
});
