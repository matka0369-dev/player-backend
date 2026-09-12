import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { AccountType, AuthenticatedUser } from '../auth/auth.types';
import {
  ADMIN_ASSIGNABLE_PERMISSIONS,
  AGENT_STAFF_ALLOWED_PERMISSIONS,
  PERMISSIONS,
  PermissionKey,
} from '../rbac/permissions.constants';
import { RatesService } from '../rates/rates.service';
import { LedgerService } from '../ledger/ledger.service';
import { BET_TYPES, DEFAULT_AGENT_SHARE, PROFIT_SHARE_TOTAL } from '../rates/rates.constants';
import { CreateUserDto } from './dto/create-user.dto';

const userSummarySelect = {
  id: true,
  email: true,
  username: true,
  accountType: true,
  isActive: true,
  agentId: true,
  balance: true,
  winningsBalance: true,
  agentShare: true,
  defaultAgentShare: true,
  createdById: true,
  createdAt: true,
  // Every account is owned by whoever created it, and the UI shows that
  // ownership rather than making callers resolve ids themselves.
  createdBy: { select: { id: true, username: true, accountType: true } },
  agent: { select: { id: true, username: true } },
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly ratesService: RatesService,
    private readonly ledgerService: LedgerService,
  ) {}

  // The ids of every Agent belonging to an Admin. `createdById` is the
  // ownership edge: an Agent belongs to the Admin that created it, for good.
  private async agentIdsOwnedBy(adminId: string): Promise<string[]> {
    const agents = await this.prisma.user.findMany({
      where: { accountType: 'AGENT', createdById: adminId },
      select: { id: true },
    });
    return agents.map((agent) => agent.id);
  }

  // ADMIN_STAFF/AGENT_STAFF own no subtree of their own — they act entirely
  // via held Roles, within whoever created them. This resolves "whose
  // subtree am I acting in": the Worker's creator for a Worker, or the
  // caller itself for every native tier.
  private resolveScopeOwnerId(requester: AuthenticatedUser): string {
    if (requester.accountType === 'ADMIN_STAFF' || requester.accountType === 'AGENT_STAFF') {
      // A Worker always has a creator — nothing else can hold this accountType.
      return requester.createdById!;
    }
    return requester.id;
  }

  /**
   * Which accounts a caller may see, as a Prisma filter. Each tier sees only
   * its own slice of the hierarchy — nobody gets a global view:
   *
   * - Platform Admin sees Admins only. It is the root of the tree and its job
   *   is provisioning Admins, not supervising every Player on the platform.
   * - Admin (and its own staff) sees the subtree it owns: the Agents,
   *   Players, and staff it created, plus any Player sitting under one of
   *   its Agents. Because an Admin can never create an Admin, this can never
   *   return a peer Admin.
   * - Agent (and its own staff) sees the Players assigned to it, plus its
   *   own staff roster.
   *
   * Used for both list and single-account reads so the two can't disagree.
   */
  private async visibilityFilter(requester: AuthenticatedUser): Promise<Prisma.UserWhereInput> {
    const ownerId = this.resolveScopeOwnerId(requester);

    switch (requester.accountType) {
      case 'PLATFORM_ADMIN':
        return { accountType: 'ADMIN' };

      case 'ADMIN':
      case 'ADMIN_STAFF':
        return {
          OR: [
            { createdById: ownerId },
            { agentId: { in: await this.agentIdsOwnedBy(ownerId) } },
          ],
        };

      case 'AGENT':
      case 'AGENT_STAFF':
        return {
          OR: [
            { accountType: 'PLAYER', agentId: ownerId },
            { accountType: 'AGENT_STAFF', createdById: ownerId },
          ],
        };

      default:
        throw new ForbiddenException('Not permitted to list users');
    }
  }

  // Which permission (if any) a caller needs to write-act on a given target
  // type.
  //
  // A native tier's authority over the accounts it directly owns is
  // intrinsic, never permission-gated: a native ADMIN managing its own
  // Agents/Players/staff, exactly like a native AGENT managing its own
  // Players (falls through to `return null` below) — neither needs a role
  // to do what its account type already entitles it to do. Only the
  // *delegated* staff tiers (ADMIN_STAFF/AGENT_STAFF) need an explicit
  // role, since staff have no authority of their own to fall back on; that
  // delegated authority is capped at exactly what the native tier could do
  // itself. Staff can never manage other staff — a Worker's authority
  // comes only from its Roles, and "manage a peer Worker" is not a role
  // anyone grants.
  private requiredPermissionToManage(
    requesterType: AccountType,
    targetType: AccountType,
  ): PermissionKey | null {
    const targetIsStaff = targetType === 'ADMIN_STAFF' || targetType === 'AGENT_STAFF';

    if (requesterType === 'ADMIN') {
      return null;
    }

    if (requesterType === 'ADMIN_STAFF') {
      if (targetIsStaff) {
        throw new ForbiddenException('Staff cannot manage other staff accounts');
      }
      if (targetType === 'AGENT') return PERMISSIONS.AGENT_MANAGE;
      if (targetType === 'PLAYER') return PERMISSIONS.USER_MANAGE;
    }

    if (requesterType === 'AGENT_STAFF') {
      if (targetIsStaff) {
        throw new ForbiddenException('Staff cannot manage other staff accounts');
      }
      if (targetType === 'PLAYER') return PERMISSIONS.MODERATION_MANAGE;
    }

    // AGENT managing its own Players, PLATFORM_ADMIN managing Admins: no
    // permission gate, matches today's behavior for those native tiers.
    return null;
  }

  // Shared authorization boundary for "act on this specific managed account".
  // A caller may only act within the slice of the hierarchy it can see, so
  // this reuses visibilityFilter rather than restating the rules — that
  // duplication is exactly how POST /users once shipped without a permission
  // check (see ARCHITECTURE.md).
  private async assertCanManageAccount(targetUserId: string, requester: AuthenticatedUser) {
    const target = await this.prisma.user.findFirst({
      where: { AND: [{ id: targetUserId }, await this.visibilityFilter(requester)] },
    });

    // Deliberately 404 rather than 403: an out-of-scope account should not be
    // distinguishable from one that doesn't exist.
    if (!target) {
      throw new NotFoundException('User not found');
    }

    const required = this.requiredPermissionToManage(requester.accountType, target.accountType);
    if (required && !requester.permissions.includes(required)) {
      throw new ForbiddenException(`Missing required permission: ${required}`);
    }

    return target;
  }

  // Fast live-typeahead check for account-creation UIs. This is advisory
  // only — `create()` below re-checks and is the actual source of truth,
  // since a username can be taken between this call and the create call.
  async isUsernameAvailable(username: string): Promise<boolean> {
    const existing = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    return !existing;
  }

  // Who may create which account type — the hierarchy's actual enforcement
  // point. See ARCHITECTURE.md: no tier creates accounts for a tier below
  // the next one down, except the bounded staff-delegation exception (an
  // Admin/Agent's own Workers may act on their creator's behalf, but never
  // create further Workers — no sub-delegation depth).
  async create(dto: CreateUserDto, requester: AuthenticatedUser) {
    // Whose subtree the new account lands in — the real Admin/Agent, even
    // when a Worker is the one performing the request. A Worker's own id
    // must never appear as an owner in the hierarchy; it owns nothing.
    const ownerId = this.resolveScopeOwnerId(requester);

    // Funding an account at creation is the same authority as funding it
    // afterwards, so it carries the same gate. Deliberately checked here,
    // before the account-type branching below narrows `requester` — this is
    // the second doorway to token authority, and a boundary that only holds
    // at one of two entrances is not a boundary. (Placed after the narrowing,
    // the Agent arm of this check becomes provably dead code, which reads as
    // protection while providing none if the branching above ever changes.)
    if (dto.openingBalance !== undefined) {
      if (requester.accountType === 'AGENT' || requester.accountType === 'AGENT_STAFF') {
        throw new ForbiddenException('Agents have no token authority');
      }
      // Platform Admin provisions Admins and nothing else — see
      // ARCHITECTURE.md: "Platform Admin sees Admins only... its job is
      // provisioning Admins, not supervising every Player." Token authority
      // was deliberately scoped to Admin tier alone, so this is a clear,
      // permanent rejection rather than "Missing required permission" — that
      // phrasing would wrongly imply granting a role could unlock it, and
      // nothing assigns Platform Admin any role to begin with (its
      // `permissions` array is always empty; it bypasses permission-gated
      // routes by account-type check, not by holding permissions).
      if (requester.accountType === 'PLATFORM_ADMIN') {
        throw new ForbiddenException('Platform Admin has no token authority');
      }
      // Native ADMIN's token authority is intrinsic (see
      // requiredPermissionToManage) — only its staff needs the explicit
      // permission, since staff have no authority of their own.
      if (
        requester.accountType !== 'ADMIN' &&
        !requester.permissions.includes(PERMISSIONS.TOKEN_ADMINISTER)
      ) {
        throw new ForbiddenException(`Missing required permission: ${PERMISSIONS.TOKEN_ADMINISTER}`);
      }
    }

    if (requester.accountType === 'PLATFORM_ADMIN') {
      if (dto.accountType !== 'ADMIN') {
        throw new ForbiddenException('Platform Admin may only create Admin accounts');
      }
    } else if (requester.accountType === 'ADMIN') {
      // Intrinsic — a native Admin creating an Agent or its own staff needs
      // no permission, mirroring a native Agent's intrinsic authority over
      // its own Players. Notably absent: PLAYER. An Admin does not create
      // Players and does not assign them to Agents — a Player only ever
      // comes into being through the Agent it belongs to, immediately below.
      if (dto.accountType !== 'AGENT' && dto.accountType !== 'ADMIN_STAFF') {
        throw new ForbiddenException('Admin may only create Agent or Admin-staff accounts');
      }
    } else if (requester.accountType === 'ADMIN_STAFF') {
      if (dto.accountType !== 'AGENT') {
        throw new ForbiddenException('Admin staff may only create Agent accounts');
      }
      if (!requester.permissions.includes(PERMISSIONS.AGENT_MANAGE)) {
        throw new ForbiddenException(`Missing required permission: ${PERMISSIONS.AGENT_MANAGE}`);
      }
    } else if (requester.accountType === 'AGENT') {
      // Intrinsic, same as an Admin creating an Agent — a native Agent's
      // Players are its own, the same way its authority to moderate them
      // already was. Notably absent: AGENT_STAFF also creating Players —
      // that stays a native-tier-only capability, matching how staff never
      // get account-creation authority anywhere else in this hierarchy.
      if (dto.accountType !== 'AGENT_STAFF' && dto.accountType !== 'PLAYER') {
        throw new ForbiddenException('Agent may only create Player or Agent-staff accounts');
      }
    } else {
      throw new ForbiddenException('Not permitted to create accounts');
    }

    // A Player's agent is never a choice — it's whichever Agent is creating
    // it. There is no "assign a Player to an Agent" step anywhere in this
    // system: an Admin cannot create a Player, and cannot re-parent one to a
    // different Agent after the fact either. The relationship is fixed at
    // birth, by the only account type that can bring a Player into being.
    // (`ownerId`, not `requester.id`: only a native Agent ever reaches this
    // branch — AGENT_STAFF has no account-creation authority at all — but
    // `ownerId` is the form every other branch in this function uses, and
    // for a native tier the two are always equal.)
    const agentId = dto.accountType === 'PLAYER' ? ownerId : null;

    // Roles are only meaningful for a Worker (ADMIN_STAFF / AGENT_STAFF) —
    // nothing else in the system reads permissions for a native Admin,
    // Agent, or Player (a native tier's authority is intrinsic; see
    // requiredPermissionToManage). Validated up front so a bogus role id
    // fails before the account is created rather than leaving a
    // half-set-up account behind. Agent-created staff are further
    // restricted to the roles an Agent may delegate — see
    // AGENT_STAFF_ALLOWED_PERMISSIONS.
    let roleIds: string[] = [];
    if (
      (dto.accountType === 'ADMIN_STAFF' || dto.accountType === 'AGENT_STAFF') &&
      dto.roleIds?.length
    ) {
      const roles = await this.prisma.role.findMany({
        where: { id: { in: dto.roleIds } },
        include: { permissions: { include: { permission: true } } },
      });
      if (roles.length !== dto.roleIds.length) {
        throw new BadRequestException('One or more roleIds do not exist');
      }

      // Keyed off the account type being *created*, not the creator — same
      // check RolesService.assignRoleToUser runs for post-creation grants
      // (see ADMIN_ASSIGNABLE_PERMISSIONS / AGENT_STAFF_ALLOWED_PERMISSIONS),
      // duplicated here because this is the other doorway a role reaches an
      // account through. Without this, a role that would be rejected the
      // moment you tried to grant it a day later was silently accepted if
      // selected in the create form instead — same authority, weaker gate.
      const allowedForNewAccount =
        dto.accountType === 'ADMIN_STAFF' ? ADMIN_ASSIGNABLE_PERMISSIONS : AGENT_STAFF_ALLOWED_PERMISSIONS;
      if (allowedForNewAccount) {
        const disallowed = new Set<PermissionKey>();
        for (const role of roles) {
          for (const rp of role.permissions) {
            const key = rp.permission.key as PermissionKey;
            if (!allowedForNewAccount.has(key)) disallowed.add(key);
          }
        }
        if (disallowed.size > 0) {
          throw new BadRequestException(
            `The selected roles include ${[...disallowed].join(', ')}, which has no effect on a ${dto.accountType} account`,
          );
        }
      }
      roleIds = roles.map((role) => role.id);
    }

    // An Agent's profit/loss slice: explicit if given, otherwise whatever the
    // creating Admin has configured as its default, falling back to the house
    // 9:1. Resolved here so the value is fixed at creation rather than
    // re-derived later from an Admin default that may since have changed.
    let agentShare: number | null = null;
    if (dto.accountType === 'AGENT') {
      if (dto.agentShare !== undefined) {
        agentShare = dto.agentShare;
      } else {
        const admin = await this.prisma.user.findUnique({
          where: { id: ownerId },
          select: { defaultAgentShare: true },
        });
        agentShare = admin?.defaultAgentShare ?? DEFAULT_AGENT_SHARE;
      }
      if (agentShare < 0 || agentShare > PROFIT_SHARE_TOTAL) {
        throw new BadRequestException(`agentShare must be between 0 and ${PROFIT_SHARE_TOTAL}`);
      }
    }

    // A custom rate card, when supplied, replaces the inherited default (an
    // Agent's from its Admin, or a Player's live read of its Agent's GIVING)
    // outright — so it must price every bet type, not just the ones the
    // caller happened to think of. A partial card would silently mix
    // explicit and inherited values for an Agent, or — worse, for a Player,
    // where a partial PLAYING card is read exclusively once any row exists
    // (see RatesService.myCards) — silently drop the un-overridden bet
    // types from what the Player can even see. Either way, that's exactly
    // the ambiguity this option exists to remove.
    if (dto.rates !== undefined) {
      if (dto.accountType !== 'AGENT' && dto.accountType !== 'PLAYER') {
        throw new BadRequestException('rates is only meaningful when creating an AGENT or PLAYER');
      }
      const seen = new Set(dto.rates.map((r) => r.betType));
      if (seen.size !== dto.rates.length) {
        throw new BadRequestException('rates contains duplicate bet types');
      }
      const missing = BET_TYPES.filter((bt) => !seen.has(bt));
      if (missing.length > 0) {
        throw new BadRequestException(`rates is missing: ${missing.join(', ')}`);
      }
    }

    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { username: dto.username }] },
    });
    if (existing) {
      throw new ConflictException('Email or username already in use');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    // Everything an account needs to be usable lands in one transaction —
    // roles, rate card, profit split, opening balance. A half-provisioned
    // account (an Agent with no card, or a funded balance with no ledger
    // entry behind it) must not be a state this system can be observed in.
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email,
          username: dto.username,
          passwordHash,
          accountType: dto.accountType,
          agentId,
          createdById: ownerId,
          agentShare,
          // An Admin starts with the house default as its own template.
          defaultAgentShare: dto.accountType === 'ADMIN' ? DEFAULT_AGENT_SHARE : null,
          roles: roleIds.length
            ? { create: roleIds.map((roleId) => ({ roleId })) }
            : undefined,
        },
        select: userSummarySelect,
      });

      if (dto.accountType === 'ADMIN') {
        await this.ratesService.seedAdminDefaultCard(tx, user.id);
      } else if (dto.accountType === 'AGENT') {
        await this.ratesService.seedAgentCardsFrom(tx, user.id, ownerId, dto.rates);
      } else if (dto.accountType === 'PLAYER' && dto.rates) {
        // Left unset, a Player has no PLAYING rows at all and reads its
        // Agent's GIVING card live (see RatesService.myCards) — the common
        // case needs nothing here.
        await this.ratesService.seedPlayerCardFrom(tx, user.id, ownerId, dto.rates);
      }

      if (dto.openingBalance !== undefined) {
        await this.ledgerService.grantOpeningBalance(tx, {
          userId: user.id,
          amount: dto.openingBalance,
          performedById: requester.id,
        });
        // Re-read so the response carries the funded balance rather than the
        // zero the row was created with.
        return tx.user.findUniqueOrThrow({ where: { id: user.id }, select: userSummarySelect });
      }

      return user;
    });
  }

  async findAllScoped(requester: AuthenticatedUser) {
    return this.prisma.user.findMany({
      where: await this.visibilityFilter(requester),
      select: userSummarySelect,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOneScoped(id: string, requester: AuthenticatedUser) {
    // Reading yourself is always allowed — that's how each portal renders its
    // own account, and it's the only read a Player ever performs.
    if (requester.id === id) {
      const self = await this.prisma.user.findUnique({ where: { id }, select: userSummarySelect });
      if (!self) throw new NotFoundException('User not found');
      return self;
    }

    const user = await this.prisma.user.findFirst({
      where: { AND: [{ id }, await this.visibilityFilter(requester)] },
      select: userSummarySelect,
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  /**
   * Every account beneath this one. Two edges lead downward — `createdById`
   * (staff, and the Agents/Players an Admin created) and `agentId` (Players
   * under an Agent) — so a Player is reachable by both and must be
   * de-duplicated. Breadth-first with a visited set, which also means a bad
   * row pointing back upward can't spin this into an infinite loop.
   */
  private async collectDescendantIds(rootId: string): Promise<string[]> {
    const found = new Set<string>();
    let frontier = [rootId];

    while (frontier.length > 0) {
      const children = await this.prisma.user.findMany({
        where: { OR: [{ createdById: { in: frontier } }, { agentId: { in: frontier } }] },
        select: { id: true },
      });
      frontier = children
        .map((child) => child.id)
        .filter((childId) => childId !== rootId && !found.has(childId));
      frontier.forEach((childId) => found.add(childId));
    }

    return [...found];
  }

  /**
   * What toggling this account's status would actually do, so the UI can put
   * real numbers in front of someone before they pull the plug on a subtree
   * rather than making them guess at the blast radius.
   */
  async previewStatusChange(id: string, requester: AuthenticatedUser) {
    const target = await this.assertCanManageAccount(id, requester);
    const descendantIds = await this.collectDescendantIds(id);
    const nextIsActive = !target.isActive;

    const affected = await this.prisma.user.findMany({
      where: nextIsActive
        ? { id: { in: descendantIds }, deactivatedByCascadeFrom: id }
        : { id: { in: descendantIds }, isActive: true },
      select: { accountType: true },
    });

    const affectedByType: Partial<Record<AccountType, number>> = {};
    for (const user of affected) {
      affectedByType[user.accountType] = (affectedByType[user.accountType] ?? 0) + 1;
    }

    return {
      username: target.username,
      accountType: target.accountType,
      isActive: target.isActive,
      nextIsActive,
      affectedCount: affected.length,
      affectedByType,
      // Only meaningful when disabling — these are the logins about to be cut.
      sessionsToRevoke: nextIsActive
        ? 0
        : await this.prisma.session.count({
            where: {
              userId: { in: [id, ...descendantIds] },
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
          }),
    };
  }

  /**
   * Disabling an account takes its whole subtree down with it and kills every
   * live session in one transaction — "disabled" has to mean access stops
   * now, not at next login. `validateSession` already refuses an inactive
   * user, but revoking explicitly means the session list reflects reality
   * instead of leaving dead rows that still look live.
   *
   * Re-enabling only restores what this same account's cascade took down
   * (`deactivatedByCascadeFrom`), so someone disabled individually beforehand
   * stays disabled rather than being silently let back in.
   */
  async updateStatus(id: string, isActive: boolean, requester: AuthenticatedUser) {
    await this.assertCanManageAccount(id, requester);
    const descendantIds = await this.collectDescendantIds(id);

    return this.prisma.$transaction(async (tx) => {
      if (isActive) {
        await tx.user.updateMany({
          where: { id: { in: descendantIds }, deactivatedByCascadeFrom: id },
          data: { isActive: true, deactivatedByCascadeFrom: null },
        });
      } else {
        await tx.user.updateMany({
          where: { id: { in: descendantIds }, isActive: true },
          data: { isActive: false, deactivatedByCascadeFrom: id },
        });
        await tx.session.updateMany({
          where: { userId: { in: [id, ...descendantIds] }, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      return tx.user.update({
        where: { id },
        // Acting on this account directly clears the marker either way: it is
        // no longer disabled merely as somebody else's side effect.
        data: { isActive, deactivatedByCascadeFrom: null },
        select: userSummarySelect,
      });
    });
  }

  // Admin-facing "control logins" capability: view a managed user's active
  // sessions, or force-logout everywhere. Same authorization boundary as
  // updateStatus — Admin tier with user:manage, or the owning Agent.
  async listSessionsScoped(id: string, requester: AuthenticatedUser) {
    await this.assertCanManageAccount(id, requester);
    return this.authService.listSessions(id);
  }

  async forceLogoutScoped(id: string, requester: AuthenticatedUser) {
    await this.assertCanManageAccount(id, requester);
    await this.authService.revokeAllSessions(id);
  }

  // There is no assignAgent() here on purpose. A Player's agent is fixed at
  // creation — set to whoever created it (see create()) — and never
  // reassigned afterward. Admin has no authority to create Players or move
  // them between Agents; that capability belongs entirely to the Agent a
  // Player already sits under, and even an Agent doesn't reach into a peer
  // Agent's roster. See ARCHITECTURE.md "Native tier authority is
  // intrinsic" for how this replaced the earlier PATCH /users/:id/agent
  // endpoint.

  // Platform Admin's one window into an Admin's business — everything else
  // about that Admin's subtree (individual Agents, Players, predictions)
  // deliberately stays invisible per ARCHITECTURE.md, but a rollup of *how
  // big* that business is doesn't leak anything about any one account in
  // it. "Daily average play" is all-time volume divided by how long the
  // Admin has existed — a business two days old and one two years old with
  // the same lifetime total obviously don't have the same daily pace.
  async businessSummary(adminId: string) {
    const admin = await this.prisma.user.findFirst({
      where: { id: adminId, accountType: 'ADMIN' },
      select: { id: true, username: true, createdAt: true },
    });
    if (!admin) throw new NotFoundException('Admin not found');

    const agents = await this.prisma.user.findMany({
      where: { accountType: 'AGENT', createdById: adminId },
      select: { id: true, isActive: true },
    });
    const agentIds = agents.map((a) => a.id);

    const [players, predictionAgg] = await Promise.all([
      agentIds.length
        ? this.prisma.user.findMany({
            where: { accountType: 'PLAYER', agentId: { in: agentIds } },
            select: { isActive: true },
          })
        : Promise.resolve([] as { isActive: boolean }[]),
      agentIds.length
        ? this.prisma.prediction.aggregate({
            where: { user: { accountType: 'PLAYER', agentId: { in: agentIds } } },
            _count: true,
            _sum: { stake: true },
          })
        : Promise.resolve({ _count: 0 as number, _sum: { stake: null as number | null } }),
    ]);

    const daysActive = Math.max(
      1,
      Math.ceil((Date.now() - admin.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
    );
    const totalCount = predictionAgg._count;
    const totalStake = predictionAgg._sum.stake ?? 0;
    const round2 = (n: number) => Math.round(n * 100) / 100;

    return {
      adminId: admin.id,
      username: admin.username,
      createdAt: admin.createdAt,
      agents: { total: agents.length, active: agents.filter((a) => a.isActive).length },
      players: { total: players.length, active: players.filter((p) => p.isActive).length },
      predictions: {
        totalCount,
        totalStake,
        dailyAverageCount: round2(totalCount / daysActive),
        dailyAverageStake: round2(totalStake / daysActive),
      },
    };
  }
}
