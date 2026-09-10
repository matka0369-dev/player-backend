import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { PermissionKey } from './permissions.constants';

// Must run after SessionAuthGuard (needs request.user already populated).
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionKey[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('No authenticated user');
    }

    // Platform Admin is the bootstrapping superuser — every other account
    // type must hold explicit permissions. See ARCHITECTURE.md.
    if (user.accountType === 'PLATFORM_ADMIN') {
      return true;
    }

    const hasAll = required.every((perm) => user.permissions.includes(perm));
    if (!hasAll) {
      throw new ForbiddenException(`Missing required permission(s): ${required.join(', ')}`);
    }

    return true;
  }
}
