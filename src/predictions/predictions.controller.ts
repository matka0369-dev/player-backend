import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { AccountTypesGuard } from '../rbac/account-types.guard';
import { RequireAccountTypes } from '../rbac/account-types.decorator';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { PredictionsService } from './predictions.service';

/**
 * Normalise a repeatable query param into a flat id list, accepting both
 * `?agentId=a&agentId=b` (Express gives an array) and `?agentId=a,b`.
 * Filtering blanks matters because an empty multi-select posts `agentId=`,
 * which must read as "no filter" rather than "an agent whose id is ''".
 */
function parseIdList(value?: string | string[]): string[] {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

@Controller('predictions')
@UseGuards(SessionAuthGuard)
export class PredictionsController {
  constructor(private readonly predictionsService: PredictionsService) {}

  @Get('me')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLAYER')
  myPredictions(@Req() req: AuthenticatedRequest) {
    return this.predictionsService.myPredictions(req.user!);
  }

  @Get()
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('AGENT', 'AGENT_STAFF', 'ADMIN', 'ADMIN_STAFF')
  listForSubtree(@Req() req: AuthenticatedRequest) {
    return this.predictionsService.listForSubtree(req.user!);
  }

  // The Admin book: totals per number, never per player. Agent tier is
  // excluded deliberately — an Agent has few enough players that the
  // itemised list on GET /predictions is the more useful view for it.
  @Get('aggregate')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('ADMIN', 'ADMIN_STAFF')
  aggregate(
    @Req() req: AuthenticatedRequest,
    @Query('gameId') gameId?: string,
    @Query('date') date?: string,
    // Repeatable (?agentId=a&agentId=b) or comma-separated — Express hands
    // the first form back as an array, so both shapes are normalised here
    // rather than forcing one on the caller.
    @Query('agentId') agentId?: string | string[],
  ) {
    return this.predictionsService.aggregateForAdmin(req.user!, {
      gameId,
      date,
      agentIds: parseIdList(agentId),
    });
  }

  /**
   * The persisted Admin<->Agent position. Both tiers read the same rows;
   * the service negates the signs for the Agent, since the two sides are
   * mirrors of one number.
   */
  @Get('settlements')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('ADMIN', 'ADMIN_STAFF', 'AGENT', 'AGENT_STAFF')
  settlements(
    @Req() req: AuthenticatedRequest,
    @Query('gameId') gameId?: string,
    @Query('date') date?: string,
    @Query('agentId') agentId?: string,
  ) {
    return this.predictionsService.settlements(req.user!, { gameId, date, agentId });
  }

  @Get('summary')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('ADMIN', 'ADMIN_STAFF')
  summary(
    @Req() req: AuthenticatedRequest,
    @Query('gameId') gameId?: string,
    @Query('date') date?: string,
  ) {
    return this.predictionsService.summaryByAgent(req.user!, { gameId, date });
  }

  // Aggregate-only — see PredictionsService.volumeSummary for why Platform
  // Admin never gets a per-prediction list.
  @Get('volume')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLATFORM_ADMIN')
  volume() {
    return this.predictionsService.volumeSummary();
  }
}
