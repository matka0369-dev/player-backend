import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { effectiveTier, resolveScopeOwnerId } from '../rbac/scope.util';

const predictionSelect = {
  id: true,
  typeId: true,
  pickedNumber: true,
  stake: true,
  oddsMultiplier: true,
  outcome: true,
  payout: true,
  createdAt: true,
  user: { select: { id: true, username: true } },
  round: {
    select: {
      id: true,
      date: true,
      game: { select: { id: true, name: true } },
    },
  },
} as const;

@Injectable()
export class PredictionsService {
  constructor(private readonly prisma: PrismaService) {}

  // A Player's own history — the only tier a Prediction's userId can ever
  // point to (Workers and every tier above have no token authority to bet
  // with, so nothing else in this hierarchy ever places one).
  async myPredictions(requester: AuthenticatedUser) {
    return this.prisma.prediction.findMany({
      where: { userId: requester.id },
      select: predictionSelect,
      orderBy: { createdAt: 'desc' },
    });
  }

  // The ids of every Agent belonging to an Admin — same helper
  // UsersService.agentIdsOwnedBy performs, needed here to scope an Admin's
  // view down to Players under any of its Agents.
  private async agentIdsOwnedBy(adminId: string): Promise<string[]> {
    const agents = await this.prisma.user.findMany({
      where: { accountType: 'AGENT', createdById: adminId },
      select: { id: true },
    });
    return agents.map((a) => a.id);
  }

  // Agent (+ AGENT_STAFF) sees predictions from its own Players; Admin
  // (+ ADMIN_STAFF) sees predictions from every Player under any Agent it
  // created — its whole subtree. Mirrors UsersService.visibilityFilter's
  // shape without duplicating it (that one scopes User rows, this scopes
  // Prediction rows one hop further through user.agentId).
  async listForSubtree(requester: AuthenticatedUser) {
    const ownerId = resolveScopeOwnerId(requester);
    let playerFilter: Prisma.UserWhereInput;

    switch (requester.accountType) {
      case 'AGENT':
      case 'AGENT_STAFF':
        playerFilter = { accountType: 'PLAYER', agentId: ownerId };
        break;
      case 'ADMIN':
      case 'ADMIN_STAFF':
        playerFilter = { accountType: 'PLAYER', agentId: { in: await this.agentIdsOwnedBy(ownerId) } };
        break;
      default:
        return [];
    }

    return this.prisma.prediction.findMany({
      where: { user: playerFilter },
      select: predictionSelect,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The Admin-facing book: how much is riding on each number, per game per
   * date — not who bet it.
   *
   * An Admin supervising a subtree wants "how exposed am I on 7 today",
   * which a per-player list answers badly and a per-number total answers
   * directly. Individual bets stay visible to the Agent that owns the
   * Player, which is the tier that actually deals with them.
   *
   * `odds` is returned **only when the selection narrows to exactly one
   * agent**. Rates are per-agent, so the same number aggregated across
   * several agents has no single multiplier — showing one would be inventing
   * a number. Otherwise the field is null and the UI hides the column.
   *
   * `agentIds` accepts several (the Admin's filter is multi-select), and any
   * id outside this Admin's subtree is simply dropped rather than erroring —
   * the "existence isn't information you're owed" rule the rest of the API
   * uses.
   */
  async aggregateForAdmin(
    requester: AuthenticatedUser,
    filters: { gameId?: string; date?: string; agentIds?: string[] },
  ) {
    const ownerId = resolveScopeOwnerId(requester);
    const agentIds = await this.agentIdsOwnedBy(ownerId);

    const requested = filters.agentIds?.filter(Boolean) ?? [];
    const scopedAgentIds = requested.length
      ? agentIds.filter((id) => requested.includes(id))
      : agentIds;

    // Exactly one *resolved* agent, not one requested — asking for one id
    // that isn't yours must not unlock a rate column over an empty set.
    const singleAgent = scopedAgentIds.length === 1;

    if (scopedAgentIds.length === 0) return { singleAgent: false, rows: [] };

    const rows = await this.prisma.$queryRaw<
      {
        gameId: string;
        gameName: string;
        date: Date;
        typeId: string;
        pickedNumber: string;
        betCount: bigint;
        totalStake: bigint;
        odds: number | null;
      }[]
    >`
      SELECT g.id AS "gameId", g.name AS "gameName", r.date,
             p.type_id::text AS "typeId", p.picked_number AS "pickedNumber",
             COUNT(p.id) AS "betCount", SUM(p.stake) AS "totalStake",
             -- Only meaningful when the selection resolved to one agent;
             -- across agents the rates differ per row and MIN would be a lie.
             CASE WHEN ${singleAgent} THEN MIN(p.odds_multiplier) ELSE NULL END AS "odds"
      FROM predictions p
      JOIN users player ON player.id = p.user_id
      JOIN rounds r ON r.id = p.round_id
      JOIN games g ON g.id = r.game_id
      WHERE player.agent_id = ANY(${scopedAgentIds})
        ${filters.gameId ? Prisma.sql`AND g.id = ${filters.gameId}` : Prisma.empty}
        ${filters.date ? Prisma.sql`AND r.date = ${new Date(`${filters.date}T00:00:00.000Z`)}` : Prisma.empty}
      GROUP BY g.id, g.name, r.date, p.type_id, p.picked_number
      ORDER BY r.date DESC, g.name, p.type_id, SUM(p.stake) DESC
    `;

    return {
      singleAgent,
      rows: rows.map((r) => ({
        gameId: r.gameId,
        gameName: r.gameName,
        date: r.date.toISOString().slice(0, 10),
        typeId: r.typeId,
        pickedNumber: r.pickedNumber,
        betCount: Number(r.betCount),
        totalStake: Number(r.totalStake),
        odds: r.odds,
      })),
    };
  }

  /**
   * Per (game, date, agent) money summary — stake collected against payout
   * owed, and the difference.
   *
   * `net` here is stake-in minus paid-out for that agent's players, i.e.
   * how the *book* did, not how any particular tier did. Splitting that
   * between Admin and Agent needs the two odds now recorded on each
   * prediction and is deliberately a later iteration — see ARCHITECTURE.md.
   */
  async summaryByAgent(
    requester: AuthenticatedUser,
    filters: { gameId?: string; date?: string },
  ) {
    const ownerId = resolveScopeOwnerId(requester);
    const agentIds = await this.agentIdsOwnedBy(ownerId);
    if (agentIds.length === 0) return [];

    const rows = await this.prisma.$queryRaw<
      {
        agentId: string;
        agentUsername: string;
        gameId: string;
        gameName: string;
        date: Date;
        betCount: bigint;
        totalStake: bigint;
        totalPayout: bigint;
        pendingCount: bigint;
      }[]
    >`
      SELECT agent.id AS "agentId", agent.username AS "agentUsername",
             g.id AS "gameId", g.name AS "gameName", r.date,
             COUNT(p.id) AS "betCount",
             SUM(p.stake) AS "totalStake",
             COALESCE(SUM(p.payout), 0) AS "totalPayout",
             COUNT(*) FILTER (WHERE p.outcome = 'PENDING') AS "pendingCount"
      FROM predictions p
      JOIN users player ON player.id = p.user_id
      JOIN users agent ON agent.id = player.agent_id
      JOIN rounds r ON r.id = p.round_id
      JOIN games g ON g.id = r.game_id
      WHERE agent.id = ANY(${agentIds})
        ${filters.gameId ? Prisma.sql`AND g.id = ${filters.gameId}` : Prisma.empty}
        ${filters.date ? Prisma.sql`AND r.date = ${new Date(`${filters.date}T00:00:00.000Z`)}` : Prisma.empty}
      GROUP BY agent.id, agent.username, g.id, g.name, r.date
      ORDER BY r.date DESC, g.name, agent.username
    `;

    return rows.map((r) => ({
      agentId: r.agentId,
      agentUsername: r.agentUsername,
      gameId: r.gameId,
      gameName: r.gameName,
      date: r.date.toISOString().slice(0, 10),
      betCount: Number(r.betCount),
      totalStake: Number(r.totalStake),
      totalPayout: Number(r.totalPayout),
      net: Number(r.totalStake) - Number(r.totalPayout),
      pendingCount: Number(r.pendingCount),
    }));
  }

  /**
   * The persisted Admin<->Agent settlements, read from whichever end the
   * caller sits at.
   *
   * Stored signs are the Admin's (see the Settlement model). An Agent gets
   * them **negated**, because the two sides are exact mirrors of one
   * position — the alternative, storing both, is two numbers that can
   * disagree. `viewerIsAgent` is what the UI keys its wording off, so it
   * never has to infer whose perspective it's showing.
   *
   * Defaults to the most recent date that has any settlement, rather than
   * "today": a result entered at 01:00 for yesterday's round should still be
   * the thing you see when you open the dashboard.
   */
  async settlements(
    requester: AuthenticatedUser,
    filters: { gameId?: string; date?: string; agentId?: string },
  ) {
    const ownerId = resolveScopeOwnerId(requester);
    const tier = effectiveTier(requester);
    const viewerIsAgent = tier === 'AGENT';

    if (tier !== 'ADMIN' && !viewerIsAgent) {
      return { viewerIsAgent: false, date: null, rows: [] };
    }

    const scope: Prisma.SettlementWhereInput = viewerIsAgent
      ? { agentId: ownerId }
      : {
          adminId: ownerId,
          ...(filters.agentId ? { agentId: filters.agentId } : {}),
        };
    if (filters.gameId) scope.gameId = filters.gameId;

    // Resolve the date first so "latest" means latest *within the caller's
    // scope* — an Admin with no activity yesterday shouldn't see an empty
    // page just because some other Admin settled then.
    let date: Date | null = null;
    if (filters.date) {
      date = new Date(`${filters.date}T00:00:00.000Z`);
    } else {
      const latest = await this.prisma.settlement.findFirst({
        where: scope,
        orderBy: { date: 'desc' },
        select: { date: true },
      });
      date = latest?.date ?? null;
    }
    if (!date) return { viewerIsAgent, date: null, rows: [] };

    const rows = await this.prisma.settlement.findMany({
      where: { ...scope, date },
      orderBy: [{ gameId: 'asc' }, { agentId: 'asc' }],
      select: {
        id: true,
        date: true,
        openPana: true,
        closePana: true,
        totalStaked: true,
        totalPayout: true,
        net: true,
        game: { select: { id: true, name: true } },
        agent: { select: { id: true, username: true } },
        admin: { select: { id: true, username: true } },
        lines: {
          orderBy: [{ typeId: 'asc' }, { pickedNumber: 'asc' }],
          select: { typeId: true, pickedNumber: true, stake: true, agentOdds: true, payout: true },
        },
      },
    });

    const sign = viewerIsAgent ? -1 : 1;

    return {
      viewerIsAgent,
      date: date.toISOString().slice(0, 10),
      rows: rows.map((r) => ({
        id: r.id,
        date: r.date.toISOString().slice(0, 10),
        gameId: r.game.id,
        gameName: r.game.name,
        agentId: r.agent.id,
        agentUsername: r.agent.username,
        adminId: r.admin.id,
        adminUsername: r.admin.username,
        openPana: r.openPana,
        closePana: r.closePana,
        // Flipped as a unit so the three always agree with each other.
        totalStaked: r.totalStaked * sign,
        totalPayout: r.totalPayout * sign,
        net: r.net * sign,
        lines: r.lines.map((l) => ({
          typeId: l.typeId,
          pickedNumber: l.pickedNumber,
          stake: l.stake,
          agentOdds: l.agentOdds,
          // The payout keeps its own sign flip: it's money owed one way.
          payout: l.payout * sign,
        })),
      })),
    };
  }

  // Platform Admin has no interest in any individual bet — "who bet what"
  // is entirely below its tier — but does need to know how much volume the
  // platform is moving, and by which Admin. Aggregate only, on purpose: no
  // route anywhere lets a Platform Admin list actual Prediction rows.
  async volumeSummary() {
    const [totals, byAdmin] = await Promise.all([
      this.prisma.prediction.aggregate({ _sum: { stake: true }, _count: true }),
      this.prisma.$queryRaw<{ adminId: string; adminUsername: string; predictionCount: bigint; totalStake: bigint }[]>`
        SELECT admin.id AS "adminId", admin.username AS "adminUsername",
               COUNT(p.id) AS "predictionCount", COALESCE(SUM(p.stake), 0) AS "totalStake"
        FROM predictions p
        JOIN users player ON player.id = p.user_id
        JOIN users agent ON agent.id = player.agent_id
        JOIN users admin ON admin.id = agent.created_by_id
        GROUP BY admin.id, admin.username
        ORDER BY "totalStake" DESC
      `,
    ]);

    return {
      totalStake: totals._sum.stake ?? 0,
      totalPredictions: totals._count,
      byAdmin: byAdmin.map((row) => ({
        adminId: row.adminId,
        adminUsername: row.adminUsername,
        predictionCount: Number(row.predictionCount),
        totalStake: Number(row.totalStake),
      })),
    };
  }
}
