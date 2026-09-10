import { randomBytes, createHash } from 'crypto';

// Raw token goes in the httpOnly cookie; only its hash is ever stored, so a
// DB read (or leak) can't be replayed into a valid session cookie.
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
