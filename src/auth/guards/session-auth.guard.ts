import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from '../auth.service';
import type { AuthenticatedRequest } from '../auth.types';
import { sessionCookieFromRequest } from '../session-cookie.constants';
import { SESSION_TTL_MS } from '../session-token.util';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Namespaced per portal so four consoles can be signed in at once — see
    // session-cookie.constants for why, and why it isn't a security boundary.
    // sessionCookieFromRequest (not just the X-Portal-computed name) so a
    // header-less request — a plain `<img src>`, e.g. a token-request
    // thumbnail — still finds the one cookie this origin actually has.
    const found = sessionCookieFromRequest(request);

    if (!found) {
      throw new UnauthorizedException('No session');
    }

    const result = await this.authService.validateSession(found.rawToken);
    if (!result) {
      throw new UnauthorizedException('Session invalid or expired');
    }

    // The DB row is already renewed by this point — this just carries the
    // same fresh expiry over to the cookie so the browser stops sending it
    // once the *new* window lapses instead of the original one. Reissued
    // under the name it was actually found at, not necessarily the
    // X-Portal-computed one (see sessionCookieFromRequest).
    if (result.renewed) {
      const response = context.switchToHttp().getResponse<Response>();
      response.cookie(found.name, found.rawToken, {
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
