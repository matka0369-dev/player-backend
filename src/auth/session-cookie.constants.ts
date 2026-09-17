/**
 * Session cookies are per-portal, because cookies are scoped by host and
 * ignore the port.
 *
 * All four portals are served from localhost in development, and from four
 * origins that may still share a parent domain in production, so a single
 * cookie name means one shared session slot: signing into the Agent portal
 * silently replaces an Admin session in the next tab. That makes the product
 * impossible to demonstrate as the four-tier system it is, and in production
 * it means an operator running two consoles keeps logging each other out.
 *
 * The portal identifies itself with the `X-Portal` header (see the shared
 * frontend api client), and the cookie it gets is namespaced to it. Requests
 * with no header — server-to-server, curl, the test harnesses — fall back to
 * the base name, so this is additive rather than a breaking change.
 *
 * This is deliberately NOT a security boundary. It stops portals clobbering
 * each other's sessions; it does not decide what a session may do. A cookie
 * lifted from one portal and replayed with another portal's header still
 * authenticates as whoever it belongs to, and every route re-checks the
 * account type server-side — see AccountTypesGuard.
 */
export const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'predictsim_sid';

/** The portals allowed to namespace a cookie. Anything else is ignored. */
export const PORTAL_IDS = ['platform-admin', 'admin', 'agent', 'player'] as const;
export type PortalId = (typeof PORTAL_IDS)[number];

export const PORTAL_HEADER = 'x-portal';

/**
 * Cookie name for the portal that sent this request.
 *
 * Unknown values fall back to the base name rather than being rejected: an
 * attacker-chosen header can then only ever reach the shared slot it could
 * already reach, and a typo in a frontend build degrades to the old
 * behaviour instead of a login loop nobody can diagnose.
 */
export function sessionCookieNameFor(portal: unknown): string {
  return typeof portal === 'string' && (PORTAL_IDS as readonly string[]).includes(portal)
    ? `${SESSION_COOKIE_NAME}_${portal.replace(/-/g, '_')}`
    : SESSION_COOKIE_NAME;
}

/** Reads the portal header off an Express-style request. */
export function sessionCookieNameForRequest(req: { headers?: Record<string, unknown> }): string {
  const raw = req.headers?.[PORTAL_HEADER];
  return sessionCookieNameFor(Array.isArray(raw) ? raw[0] : raw);
}

/**
 * Finds the session cookie actually present on a request — both its name
 * and value — rather than assuming the one `sessionCookieNameForRequest`
 * would compute from the `X-Portal` header is the one that's there.
 *
 * A plain `<img src>` request (the token-request image thumbnail) can never
 * carry a custom header, so `X-Portal` is always absent on it — but the
 * browser still sends every cookie for the origin, which on any single
 * portal's own origin is exactly one: the namespaced cookie that portal's
 * own login set. Looking only for the *computed* (unnamespaced, since no
 * header) name would 401 a cookie that is genuinely there. Falls back to
 * the first cookie whose name carries `SESSION_COOKIE_NAME` as a prefix —
 * safe because one origin never holds more than one session cookie.
 */
export function sessionCookieFromRequest(req: {
  headers?: Record<string, unknown>;
  cookies?: Record<string, string | undefined>;
}): { name: string; rawToken: string } | null {
  const computedName = sessionCookieNameForRequest(req);
  const direct = req.cookies?.[computedName];
  if (direct) return { name: computedName, rawToken: direct };

  for (const [name, value] of Object.entries(req.cookies ?? {})) {
    if (value && name.startsWith(SESSION_COOKIE_NAME)) {
      return { name, rawToken: value };
    }
  }
  return null;
}
