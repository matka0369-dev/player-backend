// Canonical list of permission keys. Adding a new capability means adding a
// key here, seeding it in prisma/seed.ts, and attaching it to a Role.
// Deliberately no permission key exists for granting/deducting tokens
// outside TOKEN_ADMINISTER, and no permission scopes it to a hierarchy tier
// — see ARCHITECTURE.md "Hard safety boundaries".
export const PERMISSIONS = {
  USER_MANAGE: 'user:manage',
  AGENT_MANAGE: 'agent:manage',
  TOKEN_ADMINISTER: 'token:administer',
  GAME_MANAGE: 'game:manage',
  REPORT_VIEW: 'report:view',
  MODERATION_MANAGE: 'moderation:manage',
  // Editing your own payout card — an Admin's DEFAULT template, or an
  // Agent's GIVING card. Never grants authority over anyone else's card.
  RATE_MANAGE: 'rate:manage',
  // Working an Agent's token-request queue: claim, comment, reject. Not
  // approve — approving a TOP_UP moves the Agent's own tokens, and no
  // permission in this system hands staff token authority. The split is
  // enforced in TokenRequestsService.approve, not by this key's absence.
  REQUEST_MANAGE: 'request:manage',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: PermissionKey[] = Object.values(PERMISSIONS);

// Roles grantable to an Agent's own staff (AGENT_STAFF). Agent-side
// delegation is deliberately narrow: staff never get account-creation or
// token authority, only the day-to-day moderation duty an Agent already
// has — see ARCHITECTURE.md "Hard safety boundaries". Shared by
// UsersService (creation-time roleIds) and RolesService (post-creation
// assign/unassign) so the two can't drift apart.
export const AGENT_STAFF_ALLOWED_PERMISSIONS = new Set<PermissionKey>([
  PERMISSIONS.MODERATION_MANAGE,
  PERMISSIONS.REPORT_VIEW,
  // The Agent's own GIVING card, which the Agent already controls — and
  // which is capped by its GIVEN card regardless of who edits it, so
  // delegating this can't widen the Agent's own exposure.
  PERMISSIONS.RATE_MANAGE,
  // Triage only. Safe to delegate precisely because it stops short of
  // approval — rejecting a request moves nothing.
  PERMISSIONS.REQUEST_MANAGE,
]);

// Roles grantable to an ADMIN (by Platform Admin) or an ADMIN_STAFF (by its
// creating Admin). Deliberately excludes MODERATION_MANAGE: tracing
// UsersService.requiredPermissionToManage, that permission is checked in
// exactly one place — an AGENT_STAFF moderating a Player. An Admin's own
// player-moderation path is gated by USER_MANAGE, not MODERATION_MANAGE, so
// granting "Moderator" to an Admin or Admin-staff account would be
// decorative: the role would render as held but authorize nothing, the same
// as any role held by a Player. GAME_MANAGE/REPORT_VIEW are included even
// though no route reads them yet — they're scaffolded for the Admin-tier
// game-config and reporting work on the roadmap, not mis-scoped like
// MODERATION_MANAGE is.
export const ADMIN_ASSIGNABLE_PERMISSIONS = new Set<PermissionKey>([
  PERMISSIONS.USER_MANAGE,
  PERMISSIONS.AGENT_MANAGE,
  PERMISSIONS.TOKEN_ADMINISTER,
  PERMISSIONS.RATE_MANAGE,
  PERMISSIONS.GAME_MANAGE,
  PERMISSIONS.REPORT_VIEW,
]);
