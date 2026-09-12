import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { PERMISSIONS } from '../rbac/permissions.constants';
import { effectiveTier, isStaff, resolveScopeOwnerId } from '../rbac/scope.util';
import { DEFAULT_RATES } from '../rates/rates.constants';
import { MAX_PAYOUT } from './results.service';
import { CreateGameDto } from './dto/create-game.dto';
import { UpdateGameDto } from './dto/update-game.dto';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { SetEnablementDto } from './dto/set-enablement.dto';

// Storing a full Date for a Postgres `time`-typed column: only the
// time-of-day component is meaningful, so every value is anchored to the
// same epoch date. Symmetric with timeOfDayToString below.
function timeOfDayToDate(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(1970, 0, 1, h, m, 0));
}

function timeOfDayToString(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function serializeGame<T extends { openTime: Date; closeTime: Date }>(game: T) {
  return { ...game, openTime: timeOfDayToString(game.openTime), closeTime: timeOfDayToString(game.closeTime) };
}

/**
 * The largest stake whose payout still fits the int4 payout columns at the
 * richest rate on the board. `maxStake` alone says nothing about risk — it
 * is the product with the multiplier that overflows — so the bound is
 * derived from the house card rather than written as a literal, and moves
 * on its own if FULL_SANGAM is ever repriced.
 *
 * An Agent may hold a custom rate above the house one, so this is early,
 * friendly feedback rather than the guarantee; prediction-service checks
 * the actual stake against the actual odds at placement.
 */
/**
 * Zone a new Game is created in when the caller doesn't name one. This is
 * the market the platform operates in, not a neutral default — a game's
 * clock times and its betting day are meaningless without one, and silently
 * falling back to UTC is exactly the bug this replaced (the day would roll
 * over at 05:30 local). Existing rows keep the 'UTC' the column was
 * backfilled with; only new games land here.
 */
export const DEFAULT_GAME_TIMEZONE = 'Asia/Kolkata';

const HIGHEST_DEFAULT_MULTIPLIER = Math.max(...Object.values(DEFAULT_RATES));
const SAFE_MAX_STAKE = Math.floor(MAX_PAYOUT / HIGHEST_DEFAULT_MULTIPLIER);

/**
 * Shared by create and update: a Game has to describe a window a Round can
 * actually be generated from, and a stake range whose payouts are
 * representable.
 */
function assertGameIsCoherent(openTime: string, closeTime: string, minStake: number, maxStake: number) {
  if (minStake > maxStake) {
    throw new BadRequestException('minStake cannot exceed maxStake');
  }
  // A Round derives opensAt and closesAt from one date, so an overnight
  // window yields closesAt *before* opensAt and a close side that can never
  // be bet. Rejected rather than silently generating broken rounds; real
  // overnight support means rolling closesAt to the next day.
  if (closeTime <= openTime) {
    throw new BadRequestException(
      `closeTime (${closeTime}) must be later in the day than openTime (${openTime}). ` +
        'Games that run past midnight UTC are not supported yet.',
    );
  }
  if (maxStake > SAFE_MAX_STAKE) {
    throw new BadRequestException(
      `maxStake cannot exceed ${SAFE_MAX_STAKE}: at the highest payout rate ` +
        `(${HIGHEST_DEFAULT_MULTIPLIER}x) a larger stake would overflow the payout column and ` +
        'block settlement for the whole round.',
    );
  }
}

@Injectable()
export class GamesService {
  constructor(private readonly prisma: PrismaService) {}

  // Platform Admin only — enforced by the controller's RequireAccountTypes,
  // same as every other Platform-Admin-only route in this app.
  async create(dto: CreateGameDto, requester: AuthenticatedUser) {
    assertGameIsCoherent(dto.openTime, dto.closeTime, dto.minStake, dto.maxStake);
    const game = await this.prisma.game.create({
      data: {
        name: dto.name,
        description: dto.description,
        openTime: timeOfDayToDate(dto.openTime),
        closeTime: timeOfDayToDate(dto.closeTime),
        timezone: dto.timezone ?? DEFAULT_GAME_TIMEZONE,
        weeklyOffDays: dto.weeklyOffDays ?? [],
        minStake: dto.minStake,
        maxStake: dto.maxStake,
        createdById: requester.id,
      },
    });
    return serializeGame(game);
  }

  async update(id: string, dto: UpdateGameDto) {
    const existing = await this.prisma.game.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Game not found');

    // ARCHIVED is a one-way door — the game-generation scheduler and every
    // enablement toggle only ever look at ACTIVE, so nothing downstream
    // needs to special-case "was archived, un-archived, is it stale."
    // Un-archiving is deliberately not supported: create a new game instead.
    if (existing.status === 'ARCHIVED' && dto.status && dto.status !== 'ARCHIVED') {
      throw new BadRequestException('An archived game cannot be reactivated');
    }

    // Validate the *resulting* game, not just the supplied fields: editing
    // one side of a pair can invert a window or unbalance a range that was
    // fine before the patch.
    assertGameIsCoherent(
      dto.openTime ?? timeOfDayToString(existing.openTime),
      dto.closeTime ?? timeOfDayToString(existing.closeTime),
      dto.minStake ?? existing.minStake,
      dto.maxStake ?? existing.maxStake,
    );

    const game = await this.prisma.game.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.openTime !== undefined && { openTime: timeOfDayToDate(dto.openTime) }),
        ...(dto.closeTime !== undefined && { closeTime: timeOfDayToDate(dto.closeTime) }),
        ...(dto.timezone !== undefined && { timezone: dto.timezone }),
        ...(dto.weeklyOffDays !== undefined && { weeklyOffDays: dto.weeklyOffDays }),
        ...(dto.minStake !== undefined && { minStake: dto.minStake }),
        ...(dto.maxStake !== undefined && { maxStake: dto.maxStake }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
    });
    return serializeGame(game);
  }

  async addHoliday(gameId: string, dto: CreateHolidayDto) {
    const game = await this.prisma.game.findUnique({ where: { id: gameId } });
    if (!game) throw new NotFoundException('Game not found');

    const date = new Date(`${dto.date}T00:00:00.000Z`);
    const existing = await this.prisma.gameHoliday.findUnique({
      where: { gameId_date: { gameId, date } },
    });
    if (existing) throw new ConflictException('This date is already marked as a leave day');

    return this.prisma.gameHoliday.create({ data: { gameId, date, reason: dto.reason } });
  }

  async removeHoliday(gameId: string, dateStr: string) {
    const date = new Date(`${dateStr}T00:00:00.000Z`);
    const result = await this.prisma.gameHoliday.deleteMany({ where: { gameId, date } });
    if (result.count === 0) throw new NotFoundException('Leave day not found');
  }

  // Platform Admin sees every game with its full config and holiday list —
  // the management view. Admin/ADMIN_STAFF sees only what could possibly be
  // relevant to them: ACTIVE games, each annotated with whether they've
  // enabled it. Agent/Player never call this — the Predict UI gets its data
  // from prediction-service's GET /games/active instead, which already
  // resolves enablement/cutoffs/today's round; duplicating that scoped view
  // here would be a second source of truth for the same question.
  async list(requester: AuthenticatedUser) {
    if (requester.accountType === 'PLATFORM_ADMIN') {
      const games = await this.prisma.game.findMany({
        include: { holidays: { orderBy: { date: 'asc' } } },
        // By schedule, not alphabetically — a management list reads better
        // as the day's actual running order.
        orderBy: { openTime: 'asc' },
      });
      return games.map((g) => serializeGame(g));
    }

    const adminId = resolveScopeOwnerId(requester);
    const games = await this.prisma.game.findMany({
      where: { status: 'ACTIVE' },
      include: { enablements: { where: { adminId } } },
      orderBy: { openTime: 'asc' },
    });
    return games.map((g) => ({
      ...serializeGame(g),
      enablements: undefined,
      enabled: g.enablements[0]?.enabled ?? false,
    }));
  }

  // Native Admin intrinsic (no permission needed, same as every other
  // native-tier action in this app); ADMIN_STAFF needs GAME_MANAGE, which
  // has been scaffolded in ADMIN_ASSIGNABLE_PERMISSIONS since the rates
  // work but had no route to actually gate until now.
  async setEnablement(gameId: string, dto: SetEnablementDto, requester: AuthenticatedUser) {
    if (effectiveTier(requester) !== 'ADMIN') {
      throw new ForbiddenException('Only an Admin may enable or disable a game');
    }
    if (isStaff(requester) && !requester.permissions.includes(PERMISSIONS.GAME_MANAGE)) {
      throw new ForbiddenException(`Missing required permission: ${PERMISSIONS.GAME_MANAGE}`);
    }

    const game = await this.prisma.game.findFirst({ where: { id: gameId, status: 'ACTIVE' } });
    if (!game) throw new NotFoundException('Game not found');

    const adminId = resolveScopeOwnerId(requester);
    return this.prisma.gameEnablement.upsert({
      where: { gameId_adminId: { gameId, adminId } },
      update: { enabled: dto.enabled },
      create: { gameId, adminId, enabled: dto.enabled },
    });
  }
}
