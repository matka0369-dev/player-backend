import { randomBytes, createHash } from 'crypto';

// Raw token goes in the httpOnly cookie; only its hash is ever stored, so a
// DB read (or leak) can't be replayed into a valid session cookie.
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

// Sliding window, not a hard expiry: SessionAuthGuard pushes expiresAt back
// out to a fresh SESSION_TTL_MS on every request that's due for renewal (see
// SESSION_RENEW_AFTER_MS), and reissues the cookie to match — so a device
// that's opened at least once a quarter never has to sign in again. Long
// because "almost never needs to log in again" was the explicit ask; still
// bounded by an idle device eventually expiring, and always revocable via
// the sessions list/force-logout.
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// Below this much life left, a validated request renews the session back up
// to a full SESSION_TTL_MS. Anything above it skips the renewal write —
// caps it to roughly one extra DB write per session per day of active use
// instead of one per request.
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000; // 1 day
