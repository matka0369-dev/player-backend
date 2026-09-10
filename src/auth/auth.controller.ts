import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SessionAuthGuard } from './guards/session-auth.guard';
import { sessionCookieNameForRequest } from './session-cookie.constants';
import type { AuthenticatedRequest } from './auth.types';
import { SESSION_TTL_MS, hashSessionToken } from './session-token.util';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { rawToken, user } = await this.authService.login(dto.identifier, dto.password, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Namespaced to the calling portal so signing into one console does not
    // evict another's session — cookies ignore the port, so all four dev
    // portals would otherwise share a single slot.
    res.cookie(sessionCookieNameForRequest(req), rawToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
    });

    return { user };
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawToken: string | undefined = req.cookies?.[sessionCookieNameForRequest(req)];
    if (rawToken) {
      await this.authService.logout(rawToken);
    }
    res.clearCookie(sessionCookieNameForRequest(req));
    return { success: true };
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  me(@Req() req: AuthenticatedRequest) {
    return { user: req.user };
  }

  // Self-service: view/revoke your own sessions across devices.
  @Get('sessions')
  @UseGuards(SessionAuthGuard)
  listSessions(@Req() req: AuthenticatedRequest) {
    const rawToken: string | undefined = req.cookies?.[sessionCookieNameForRequest(req)];
    return this.authService.listSessions(req.user!.id, rawToken ? hashSessionToken(rawToken) : undefined);
  }

  // Revoke one specific session (e.g. "log out that one device").
  @Delete('sessions/:id')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  async revokeSession(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.authService.revokeSession(id, req.user!.id);
    return { success: true };
  }

  // "Log out everywhere else" — revokes every session except the one
  // making this request.
  @Delete('sessions')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  async revokeOtherSessions(@Req() req: AuthenticatedRequest) {
    const rawToken: string | undefined = req.cookies?.[sessionCookieNameForRequest(req)];
    await this.authService.revokeAllSessions(req.user!.id, rawToken ? hashSessionToken(rawToken) : undefined);
    return { success: true };
  }
}
