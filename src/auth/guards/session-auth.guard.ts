import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from '../auth.service';
import type { AuthenticatedRequest } from '../auth.types';
import { sessionCookieNameForRequest } from '../session-cookie.constants';
import { SESSION_TTL_MS } from '../session-token.util';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Namespaced per portal so four consoles can be signed in at once — see
    // session-cookie.constants for why, and why it isn't a security boundary.
    const cookieName = sessionCookieNameForRequest(request);
    const rawToken: string | undefined = request.cookies?.[cookieName];

    if (!rawToken) {
      throw new UnauthorizedException('No session');
    }

    const result = await this.authService.validateSession(rawToken);
    if (!result) {
      throw new UnauthorizedException('Session invalid or expired');
    }

    // The DB row is already renewed by this point — this just carries the
    // same fresh expiry over to the cookie so the browser stops sending it
    // once the *new* window lapses instead of the original one.
    if (result.renewed) {
      const response = context.switchToHttp().getResponse<Response>();
      response.cookie(cookieName, rawToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: SESSION_TTL_MS,
      });
    }

    request.user = result.user;
    return true;
  }
}
