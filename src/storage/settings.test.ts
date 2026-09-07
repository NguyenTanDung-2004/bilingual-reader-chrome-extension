import { describe, expect, it } from 'vitest';
import { isDomainBlocked } from './settings';

describe('isDomainBlocked (R10 privacy blocklist)', () => {
  const settings = { blockedDomains: ['mail.google.com', '*.atlassian.net', 'localhost'] };

  it('blocks an exact-match domain', () => {
    expect(isDomainBlocked('https://mail.google.com/mail/u/0/', settings)).toBe(true);
  });

  it('blocks a wildcard subdomain pattern', () => {
    expect(isDomainBlocked('https://my-team.atlassian.net/wiki/page', settings)).toBe(true);
  });

  it('does not block the wildcard\'s bare parent domain without a subdomain', () => {
    // "*.atlassian.net" should not match "atlassian.net" itself, only subdomains.
    expect(isDomainBlocked('https://atlassian.net/', settings)).toBe(false);
  });

  it('blocks localhost regardless of port', () => {
    expect(isDomainBlocked('http://localhost:3000/app', settings)).toBe(true);
  });

  it('does not block an unrelated domain', () => {
    expect(isDomainBlocked('https://en.wikipedia.org/wiki/Cat', settings)).toBe(false);
  });

  it('returns false for an unparseable URL instead of throwing', () => {
    expect(isDomainBlocked('not a url', settings)).toBe(false);
  });
});
