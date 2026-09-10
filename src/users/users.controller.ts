import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { AccountTypesGuard } from '../rbac/account-types.guard';
import { RequireAccountTypes } from '../rbac/account-types.decorator';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { CheckUsernameDto } from './dto/check-username.dto';

@Controller('users')
@UseGuards(SessionAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // No @RequirePermissions here: which permission is required depends on
  // *what* is being created (agent:manage for an Agent, user:manage for a
  // Player, none for a Worker an Admin/Agent creates for itself) — a single
  // static decorator can't express that, so UsersService.create() is the
  // actual enforcement point. AccountTypesGuard still gates which tiers may
  // call this route at all; AGENT_STAFF is deliberately absent — it creates
  // nothing.
  @Post()
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLATFORM_ADMIN', 'ADMIN', 'ADMIN_STAFF', 'AGENT')
  create(@Body() dto: CreateUserDto, @Req() req: AuthenticatedRequest) {
    return this.usersService.create(dto, req.user!);
  }

  @Get()
  findAll(@Req() req: AuthenticatedRequest) {
    return this.usersService.findAllScoped(req.user!);
  }

  // Must stay registered before @Get(':id') — otherwise Express matches
  // "check-username" as the :id param and this route never gets hit.
  // Same tiers as POST /users, above, for the same reason.
  @Get('check-username')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLATFORM_ADMIN', 'ADMIN', 'ADMIN_STAFF', 'AGENT')
  async checkUsername(@Query() query: CheckUsernameDto) {
    const available = await this.usersService.isUsernameAvailable(query.username);
    return { available };
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.usersService.findOneScoped(id, req.user!);
  }

  // What toggling this account would take down (or restore) with it. Read-only
  // — the UI calls this to show a real blast radius before asking to confirm.
  @Get(':id/status-impact')
  previewStatus(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.usersService.previewStatusChange(id, req.user!);
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateStatusDto, @Req() req: AuthenticatedRequest) {
    return this.usersService.updateStatus(id, dto.isActive, req.user!);
  }

  // Admin-facing "control logins": same authorization boundary as
  // updateStatus (enforced inside the service) — Admin tier with
  // user:manage, or the Agent who owns this Player.
  @Get(':id/sessions')
  listSessions(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.usersService.listSessionsScoped(id, req.user!);
  }

  @Post(':id/sessions/revoke-all')
  @HttpCode(200)
  async forceLogout(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.usersService.forceLogoutScoped(id, req.user!);
    return { success: true };
  }

  // There is no PATCH :id/agent here on purpose. A Player's agent is fixed
  // at creation and never reassigned — see UsersService.create and its
  // "no assignAgent() here" note.
}
