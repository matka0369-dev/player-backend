import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth.service';
import type { AuthenticatedRequest } from '../auth.types';
import { sessionCookieNameForRequest } from '../session-cookie.constants';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Namespaced per portal so four consoles can be signed in at once — see
    // session-cookie.constants for why, and why it isn't a security boundary.
    const rawToken: string | undefined = request.cookies?.[sessionCookieNameForRequest(request)];

    if (!rawToken) {
      throw new UnauthorizedException('No session');
    }

    const user = await this.authService.validateSession(rawToken);
    if (!user) {
      throw new UnauthorizedException('Session invalid or expired');
    }

    request.user = user;
    return true;
  }
}
