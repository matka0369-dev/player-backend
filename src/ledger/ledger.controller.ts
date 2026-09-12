import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { LedgerService } from './ledger.service';
import { GrantTokensDto } from './dto/grant-tokens.dto';
import { TransferTokensDto } from './dto/transfer-tokens.dto';

@Controller('ledger')
@UseGuards(SessionAuthGuard)
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  // Scoped inside the service — an Admin sees its subtree, an Agent its
  // Players, a Player only itself.
  @Get()
  history(
    @Req() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('date') date?: string,
    @Query('agentId') agentId?: string,
  ) {
    const parsed = Number(limit);
    return this.ledgerService.history(req.user!, Number.isFinite(parsed) ? parsed : undefined, {
      date,
      agentId,
    });
  }

  // Authorization lives in the service (token:administer + downward-only
  // scope), since the same rules govern the opening-balance path that runs
  // during account creation.
  @Post('grant/:userId')
  grant(
    @Param('userId') userId: string,
    @Body() dto: GrantTokensDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.ledgerService.grant(userId, dto.amount, req.user!, dto.note);
  }

  // Distinct route from /grant on purpose: this one moves an Agent's own
  // tokens rather than creating any, and is gated by a different check
  // (assertCanTransfer vs assertCanFund). Collapsing them into one endpoint
  // would make "who can mint" a branch inside a handler instead of a
  // property of the route.
  @Post('transfer/:playerId')
  transfer(
    @Param('playerId') playerId: string,
    @Body() dto: TransferTokensDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.ledgerService.transfer(playerId, dto.amount, req.user!, dto.note);
  }
}
