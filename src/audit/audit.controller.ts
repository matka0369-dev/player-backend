import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { AccountTypesGuard } from '../rbac/account-types.guard';
import { RequireAccountTypes } from '../rbac/account-types.decorator';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { AuditService } from './audit.service';

/** The Agent's Activity log. Owner Agent only: staff don't audit themselves. */
@Controller('audit')
@UseGuards(SessionAuthGuard, AccountTypesGuard)
@RequireAccountTypes('AGENT')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const n = Number(limit);
    return this.audit.list(req.user!, { actorId, action, from, to, limit: Number.isFinite(n) ? n : undefined });
  }
}
