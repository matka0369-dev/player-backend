import { AuthenticatedUser } from '../auth/auth.types';

/**
 * Whose subtree a caller is acting in.
 *
 * ADMIN_STAFF/AGENT_STAFF own nothing of their own — they act entirely via
 * held Roles inside whoever created them, so every ownership decision has to
 * resolve to that creator rather than to the staff account itself. Every
 * native tier resolves to itself.
 *
 * Shared rather than duplicated per-service: this is the single sentence that
 * decides what "mine" means across users, rates, and the ledger, and three
 * copies of it is three chances for one to be subtly wrong.
 */
export function resolveScopeOwnerId(requester: AuthenticatedUser): string {
  if (requester.accountType === 'ADMIN_STAFF' || requester.accountType === 'AGENT_STAFF') {
    // A staff account always has a creator — nothing else can hold this type.
    return requester.createdById!;
  }
  return requester.id;
}

/** True for the two delegate account types, which never own a subtree. */
export function isStaff(requester: AuthenticatedUser): boolean {
  return requester.accountType === 'ADMIN_STAFF' || requester.accountType === 'AGENT_STAFF';
}

/** The tier a caller effectively acts as — staff collapse onto their creator. */
export function effectiveTier(requester: AuthenticatedUser): 'PLATFORM_ADMIN' | 'ADMIN' | 'AGENT' | 'PLAYER' {
  switch (requester.accountType) {
    case 'ADMIN_STAFF':
      return 'ADMIN';
    case 'AGENT_STAFF':
      return 'AGENT';
    default:
      return requester.accountType;
  }
}
