import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { ADMIN_ASSIGNABLE_PERMISSIONS, AGENT_STAFF_ALLOWED_PERMISSIONS, PermissionKey } from '../rbac/permissions.constants';
import { CreateRoleDto } from './dto/create-role.dto';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  listRoles() {
    return this.prisma.role.findMany({
      include: { permissions: { include: { permission: true } } },
      orderBy: { name: 'asc' },
    });
  }

  listPermissions() {
    return this.prisma.permission.findMany({ orderBy: { key: 'asc' } });
  }

  // Defining new roles/permissions is a Platform Admin action — assigning an
  // *existing* role to a user is a separate, less-privileged action (see
  // assignRoleToUser). Keeping these distinct stops an Admin from minting
  // themselves a new permission they weren't granted.
  async createRole(dto: CreateRoleDto, requester: AuthenticatedUser) {
    if (requester.accountType !== 'PLATFORM_ADMIN') {
      throw new ForbiddenException('Only Platform Admin may define new roles');
    }

    const existing = await this.prisma.role.findUnique({ where: { name: dto.name } });
    if (existing) {
      throw new ConflictException('A role with this name already exists');
    }

    const permissions = await this.prisma.permission.findMany({
      where: { key: { in: dto.permissionKeys } },
    });
    if (permissions.length !== dto.permissionKeys.length) {
      throw new BadRequestException('One or more permissionKeys do not exist');
    }

    return this.prisma.role.create({
      data: {
        name: dto.name,
        description: dto.description,
        permissions: {
          create: permissions.map((p) => ({ permissionId: p.id })),
        },
      },
      include: { permissions: { include: { permission: true } } },
    });
  }

  async assignRoleToUser(userId: string, roleId: string, requester: AuthenticatedUser) {
    const user = await this.assertCanAssignRoleTo(userId, requester);

    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { permissions: { include: { permission: true } } },
    });
    if (!role) throw new NotFoundException('Role not found');

    // Keyed off the *target's* account type, not the requester's — the
    // question is which permissions do anything when held by that account
    // type, and that's a property of the target, not of who's granting it.
    this.assertRoleUsableBy(user.accountType, role.permissions.map((rp) => rp.permission.key as PermissionKey));

    await this.prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId } },
      update: {},
      create: { userId: user.id, roleId },
    });

    return this.getUserRoles(user.id);
  }

  async unassignRoleFromUser(userId: string, roleId: string, requester: AuthenticatedUser) {
    const user = await this.assertCanAssignRoleTo(userId, requester);

    await this.prisma.userRole.deleteMany({ where: { userId: user.id, roleId } });
    return this.getUserRoles(user.id);
  }

  // Rejects a role that would be silently inert on the given target account
  // type — same category of bug as a Player holding any role at all, just
  // narrower: MODERATION_MANAGE only gates AGENT_STAFF moderating a Player
  // (see UsersService.requiredPermissionToManage), so granting "Moderator" to
  // an ADMIN/ADMIN_STAFF or AGENT_STAFF granting itself something outside its
  // delegated set would authorize nothing while looking like it did. Checked
  // here (assignment) and mirrored in UsersService.create (creation-time
  // roleIds) — the same authority through two doorways.
  private assertRoleUsableBy(targetType: AuthenticatedUser['accountType'], permissionKeys: PermissionKey[]) {
    const allowed =
      targetType === 'ADMIN' || targetType === 'ADMIN_STAFF'
        ? ADMIN_ASSIGNABLE_PERMISSIONS
        : targetType === 'AGENT_STAFF'
          ? AGENT_STAFF_ALLOWED_PERMISSIONS
          : null;

    // PLATFORM_ADMIN/AGENT/PLAYER never reach here — assertCanAssignRoleTo
    // already restricts the target to ADMIN/ADMIN_STAFF/AGENT_STAFF.
    if (!allowed) return;

    const disallowed = permissionKeys.filter((key) => !allowed.has(key));
    if (disallowed.length > 0) {
      throw new BadRequestException(
        `This role includes ${disallowed.join(', ')}, which has no effect on a ${targetType} account`,
      );
    }
  }

  private getUserRoles(userId: string) {
    return this.prisma.userRole.findMany({
      where: { userId },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });
  }

  // Roles are how a Worker's capabilities are granted — nothing else in this
  // system reads permissions.includes(...) for an Agent or Player, so a role
  // held by any other account type would be inert. Two symmetric cases, each
  // scoped to the caller's own relationship to the target — closing the gap
  // the original check missed entirely: it never verified the target even
  // *was* the right type, or that the caller had any relationship to them —
  // an Admin with user:manage could previously grant or revoke a role on any
  // user id, including a peer Admin's, just by guessing it.
  //
  // - Admin -> its own ADMIN_STAFF only.
  // - Agent -> its own AGENT_STAFF only (and see assignRoleToUser for the
  //   further restriction on *which* roles an Agent may grant).
  //
  // Platform Admin is deliberately absent. Its scope is create-an-Admin and
  // manage-its-status/sessions, full stop (see ARCHITECTURE.md — restated by
  // explicit sign-off after an earlier version of this method let Platform
  // Admin edit any Admin's roles post-creation, which was scope creep beyond
  // that boundary even though it was correctly scoped to Admin-only targets).
  // An Admin's roles are now fixed at creation time (`roleIds` on
  // `POST /users`) with no remaining path to change them afterward — that's
  // a deliberate trade, not an oversight; if a narrow correction path is
  // ever needed, it should be scoped explicitly rather than reopened as a
  // general-purpose tool.
  private async assertCanAssignRoleTo(userId: string, requester: AuthenticatedUser) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    // 404 rather than 403 for the wrong-type/out-of-scope case too: which
    // ids exist and what they are isn't information this caller needs beyond
    // "not usable here."
    const notFound = (): never => {
      throw new NotFoundException('User not found');
    };

    if (requester.accountType === 'ADMIN') {
      if (!user || user.accountType !== 'ADMIN_STAFF' || user.createdById !== requester.id) notFound();
    } else if (requester.accountType === 'AGENT') {
      if (!user || user.accountType !== 'AGENT_STAFF' || user.createdById !== requester.id) notFound();
    } else {
      throw new ForbiddenException('Not permitted to assign roles');
    }

    return user!;
  }
}
