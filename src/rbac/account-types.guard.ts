import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest, AccountType } from '../auth/auth.types';
import { ACCOUNT_TYPES_KEY } from './account-types.decorator';

// Must run after SessionAuthGuard.
@Injectable()
export class AccountTypesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<AccountType[]>(ACCOUNT_TYPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!allowed || allowed.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user || !allowed.includes(user.accountType)) {
      throw new ForbiddenException('Account type not permitted for this route');
    }

    return true;
  }
}
