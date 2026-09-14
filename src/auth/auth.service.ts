import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionKey } from '../rbac/permissions.constants';
import { AuthenticatedUser } from './auth.types';
import {
  generateSessionToken,
  hashSessionToken,
  SESSION_RENEW_AFTER_MS,
  SESSION_TTL_MS,
} from './session-token.util';

const userWithRolesInclude = {
  roles: {
    include: {
      role: {
        include: {
          permissions: { include: { permission: true } },
        },
      },
    },
  },
} as const;

function toPermissionKeys(user: {
  roles: {
    role: { permissions: { permission: { key: string } }[] };
  }[];
}): PermissionKey[] {
  const keys = new Set<string>();
  for (const userRole of user.roles) {
    for (const rolePermission of userRole.role.permissions) {
      keys.add(rolePermission.permission.key);
    }
  }
  return Array.from(keys) as PermissionKey[];
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  // `identifier` is an email address or a username — both are unique columns,
  // so at most one account can match either way.
  async login(
    identifier: string,
    password: string,
    context: { ipAddress?: string; userAgent?: string },
  ): Promise<{ rawToken: string; user: AuthenticatedUser }> {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { username: identifier }] },
      include: userWithRolesInclude,
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const rawToken = generateSessionToken();
    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashSessionToken(rawToken),
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });

    return {
      rawToken,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        accountType: user.accountType,
        agentId: user.agentId,
        createdById: user.createdById,
        permissions: toPermissionKeys(user),
      },
    };
  }

  async logout(rawToken: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { tokenHash: hashSessionToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // Sliding session: a device that's used within its window never has to
  // sign in again, only one that's been idle past SESSION_TTL_MS entirely.
  // `renewed` tells the guard whether to push the cookie's maxAge out to
  // match — the DB write already happened here either way it's due.
  async validateSession(
    rawToken: string,
  ): Promise<{ user: AuthenticatedUser; renewed: boolean } | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(rawToken) },
      include: { user: { include: userWithRolesInclude } },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return null;
    }
    if (!session.user.isActive) {
      return null;
    }

    let renewed = false;
    if (session.expiresAt.getTime() - Date.now() < SESSION_TTL_MS - SESSION_RENEW_AFTER_MS) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
      });
      renewed = true;
    }

    return {
      renewed,
      user: {
        id: session.user.id,
        email: session.user.email,
        username: session.user.username,
        accountType: session.user.accountType,
        agentId: session.user.agentId,
        createdById: session.user.createdById,
        permissions: toPermissionKeys(session.user),
      },
    };
  }

  // currentTokenHash lets the caller mark which row is "this device" without
  // ever exposing tokenHash itself in the response.
  async listSessions(userId: string, currentTokenHash?: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    return sessions.map((session) => ({
      id: session.id,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      isCurrent: currentTokenHash !== undefined && session.tokenHash === currentTokenHash,
    }));
  }

  // Scoped to ownerUserId so a caller can never revoke a session that isn't
  // theirs (or, for the admin-facing path, isn't the managed user's) just by
  // guessing a session id.
  async revokeSession(sessionId: string, ownerUserId: string): Promise<void> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== ownerUserId) {
      throw new NotFoundException('Session not found');
    }
    if (session.revokedAt) {
      return;
    }
    await this.prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  }

  // exceptTokenHash lets a user log out every other session while staying
  // logged in on the one they're using right now.
  async revokeAllSessions(userId: string, exceptTokenHash?: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptTokenHash ? { tokenHash: { not: exceptTokenHash } } : {}),
      },
      data: { revokedAt: new Date() },
    });
  }
}
