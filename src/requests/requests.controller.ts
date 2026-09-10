import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { TokenRequestStatus } from '@prisma/client';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { AccountTypesGuard } from '../rbac/account-types.guard';
import { RequireAccountTypes } from '../rbac/account-types.decorator';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { RequestsService } from './requests.service';
import { CreateTokenRequestDto, ResolveTokenRequestDto } from './dto/create-request.dto';

/**
 * The token-request queue: a Player asks for a balance change, someone in
 * their own hierarchy resolves it, and approval writes the ledger entry in
 * the same transaction.
 *
 * Authorization is enforced in the service rather than by decorators alone,
 * because it depends on the *kind* of request being resolved — an Agent
 * approves a top-up out of its own wallet, an Admin approves a surrender that
 * destroys supply, and staff of either may only triage.
 */
@Controller('token-requests')
@UseGuards(SessionAuthGuard)
export class RequestsController {
  constructor(private readonly requestsService: RequestsService) {}

  @Post()
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLAYER')
  create(@Body() dto: CreateTokenRequestDto, @Req() req: AuthenticatedRequest) {
    return this.requestsService.create(dto, req.user!);
  }

  @Get('me')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLAYER')
  mine(@Req() req: AuthenticatedRequest) {
    return this.requestsService.mine(req.user!);
  }

  @Post(':id/cancel')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLAYER')
  cancel(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.requestsService.cancel(id, req.user!);
  }

  @Get()
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('AGENT', 'AGENT_STAFF', 'ADMIN', 'ADMIN_STAFF')
  queue(@Req() req: AuthenticatedRequest, @Query('status') status?: TokenRequestStatus) {
    return this.requestsService.queue(req.user!, status);
  }

  // Advisory lock so a queue worked by several people doesn't have two
  // reviewers on the same row. Not what prevents a double-approve — see
  // RequestsService.approve for that.
  @Post(':id/claim')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('AGENT', 'AGENT_STAFF', 'ADMIN', 'ADMIN_STAFF')
  claim(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.requestsService.claim(id, req.user!);
  }

  @Post(':id/release')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('AGENT', 'AGENT_STAFF', 'ADMIN', 'ADMIN_STAFF')
  release(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.requestsService.release(id, req.user!);
  }

  @Post(':id/reject')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('AGENT', 'AGENT_STAFF', 'ADMIN', 'ADMIN_STAFF')
  reject(
    @Param('id') id: string,
    @Body() dto: ResolveTokenRequestDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.requestsService.reject(id, dto, req.user!);
  }

  // Staff are allowed through the account-type gate and then refused inside
  // the service, on purpose: the error should say "approving moves tokens,
  // that's the account holder's alone" rather than a bare 403 that reads
  // like a missing role.
  @Post(':id/approve')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('AGENT', 'AGENT_STAFF', 'ADMIN', 'ADMIN_STAFF')
  approve(
    @Param('id') id: string,
    @Body() dto: ResolveTokenRequestDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.requestsService.approve(id, dto, req.user!);
  }
}
