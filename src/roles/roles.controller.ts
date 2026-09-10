import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { AccountTypesGuard } from '../rbac/account-types.guard';
import { RequireAccountTypes } from '../rbac/account-types.decorator';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { AssignRoleDto } from './dto/assign-role.dto';

@Controller()
@UseGuards(SessionAuthGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  // Agent included so an Agent's dashboard can show the (client-filtered)
  // catalog when creating its own staff.
  @Get('roles')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLATFORM_ADMIN', 'ADMIN', 'AGENT')
  listRoles() {
    return this.rolesService.listRoles();
  }

  @Get('permissions')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLATFORM_ADMIN', 'ADMIN', 'AGENT')
  listPermissions() {
    return this.rolesService.listPermissions();
  }

  @Post('roles')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLATFORM_ADMIN')
  createRole(@Body() dto: CreateRoleDto, @Req() req: AuthenticatedRequest) {
    return this.rolesService.createRole(dto, req.user!);
  }

  // Two symmetric cases, each scoped inside RolesService.assertCanAssignRoleTo:
  // Admin -> its own ADMIN_STAFF; Agent -> its own AGENT_STAFF
  // (role-catalog-restricted). Never applies to an Agent or Player
  // themselves — nothing reads permissions for those tiers.
  //
  // PLATFORM_ADMIN is deliberately not in this allow-list: its scope is
  // create-an-Admin and manage-its-status/sessions only. An Admin's roles
  // are fixed at creation time (`roleIds` on POST /users) — there is no
  // route for Platform Admin to revisit them afterward. See
  // RolesService.assertCanAssignRoleTo for the full reasoning.
  @Post('users/:userId/roles')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('ADMIN', 'AGENT')
  assignRole(@Param('userId') userId: string, @Body() dto: AssignRoleDto, @Req() req: AuthenticatedRequest) {
    return this.rolesService.assignRoleToUser(userId, dto.roleId, req.user!);
  }

  @Delete('users/:userId/roles/:roleId')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('ADMIN', 'AGENT')
  unassignRole(@Param('userId') userId: string, @Param('roleId') roleId: string, @Req() req: AuthenticatedRequest) {
    return this.rolesService.unassignRoleFromUser(userId, roleId, req.user!);
  }
}
