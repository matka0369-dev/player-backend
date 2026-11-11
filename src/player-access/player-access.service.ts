import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { hashSessionToken } from '../auth/session-token.util';
import { UsersService } from '../users/users.service';
import type { CreateUserDto } from '../users/dto/create-user.dto';

/** How long a sign-in link stays redeemable. Short on purpose: it is a bearer
 *  credential sitting in a chat thread. A player who misses it just gets
 *  another — see issueLink. */
export const LOGIN_LINK_TTL_MS = 60 * 60 * 1000;

// Unambiguous and URL-safe: no 0/o/1/l/i. Not typed by anyone (it rides in a
// link and is baked into an Agent's APK), so length buys non-enumerability.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 8;

function randomCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/** Digits only, country code included — the shape wa.me links need. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 11 || digits.length > 15) {
    throw new BadRequestException(
      'Include the country code, e.g. 919876543210 for an Indian number',
    );
  }
  return digits;
}

@Injectable()
export class PlayerAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
  ) {}

  // Where a sign-in link points. Defaults to the deployed Player app rather
  // than keying off NODE_ENV: a wrong guess there would put localhost links in
  // every QR an Agent hands out, which fails silently on the player's phone.
  // Local development opts in with PLAYER_APP_URL=http://localhost:5176.
  private playerAppUrl(): string {
    return (process.env.PLAYER_APP_URL ?? 'https://player-alpha-rosy.vercel.app').replace(/\/+$/, '');
  }

  // Players belong to a native Agent only — AGENT_STAFF can't create them
  // (see UsersService.create), so the invite surface is native-only too.
  private assertNativeAgent(requester: AuthenticatedUser) {
    if (requester.accountType !== 'AGENT') {
      throw new ForbiddenException('Only an Agent can manage player invitations');
    }
  }

  /** The Agent's contact setup, creating its invite code on first look. */
  async myInvite(requester: AuthenticatedUser) {
    this.assertNativeAgent(requester);
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: requester.id },
      select: { whatsappNumber: true, inviteCode: true },
    });

    let code = me.inviteCode;
    // Retry on the (astronomically unlikely) unique clash rather than
    // surfacing a 500 the Agent can do nothing about.
    for (let attempt = 0; !code && attempt < 5; attempt++) {
      const candidate = randomCode();
      const taken = await this.prisma.user.findUnique({ where: { inviteCode: candidate }, select: { id: true } });
      if (taken) continue;
      await this.prisma.user.update({ where: { id: requester.id }, data: { inviteCode: candidate } });
      code = candidate;
    }
    if (!code) throw new BadRequestException('Could not create an invite code, please retry');

    return {
      whatsappNumber: me.whatsappNumber,
      inviteCode: code,
      inviteUrl: `${this.playerAppUrl()}/join/${code}`,
    };
  }

  async setWhatsapp(requester: AuthenticatedUser, raw: string) {
    this.assertNativeAgent(requester);
    await this.prisma.user.update({
      where: { id: requester.id },
      data: { whatsappNumber: normalizePhone(raw) },
    });
    return this.myInvite(requester);
  }

  /**
   * Create a Player from a WhatsApp registration request and issue its first
   * sign-in link in one step.
   *
   * Goes through UsersService.create, not around it, so a Player made this way
   * gets exactly the same checks as one made from the create form: it lands in
   * this Agent's subtree, reads this Agent's rate card, and the phone-number
   * uniqueness rule applies. The only difference is the password: nobody
   * types one, so it's a random value nobody ever sees — the Player gets in
   * through the link and then their own PIN.
   */
  async invitePlayer(requester: AuthenticatedUser, input: { phone: string; username?: string }) {
    this.assertNativeAgent(requester);
    const phone = normalizePhone(input.phone);

    const base = input.username ?? `p${phone.slice(-10)}`;
    let username = base;
    for (let attempt = 0; ; attempt++) {
      const clash = await this.prisma.user.findFirst({ where: { username }, select: { id: true } });
      if (!clash) break;
      // An explicit username that's taken is the Agent's to resolve; a derived
      // one just gets a short suffix.
      if (input.username || attempt >= 4) throw new BadRequestException('That username is already taken');
      username = `${base}${Math.floor(10 + Math.random() * 90)}`;
    }

    const user = await this.usersService.create(
      {
        email: phone,
        username,
        password: randomBytes(24).toString('hex'),
        accountType: 'PLAYER',
      } as CreateUserDto,
      requester,
    );

    const link = await this.issueLink(user.id);
    return { user, ...link };
  }

  /**
   * A fresh sign-in link for an existing Player. It starts them over: any
   * unused link is voided, their enrolled phones are revoked (so the old PIN
   * stops working) and their sessions end — the point is recovering a lost
   * phone or a forgotten PIN, where "keep whatever was there" is the wrong
   * default.
   */
  async reissueLink(requester: AuthenticatedUser, playerId: string) {
    // Same scope and permission rule as forcing a Player out: the owning
    // Agent, or its staff holding moderation:manage.
    await this.usersService.assertMayManagePlayerLogin(playerId, requester);
    await this.authService.revokeAllSessions(playerId);
    return this.issueLink(playerId, { revokeDevices: true });
  }

  private async issueLink(userId: string, opts: { revokeDevices?: boolean } = {}) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + LOGIN_LINK_TTL_MS);
    const issuerId = await this.issuerFor(userId);

    await this.prisma.$transaction([
      this.prisma.loginToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } }),
      ...(opts.revokeDevices
        ? [
            this.prisma.playerDevice.updateMany({
              where: { userId, revokedAt: null },
              data: { revokedAt: new Date() },
            }),
          ]
        : []),
      this.prisma.loginToken.create({
        data: { userId, tokenHash: hashSessionToken(token), createdById: issuerId, expiresAt },
      }),
    ]);

    return { url: `${this.playerAppUrl()}/enter#t=${token}`, expiresAt };
  }

  // The Agent that owns this Player — recorded as the link's issuer even when
  // one of its staff pressed the button, matching how the rest of the
  // hierarchy attributes staff actions to the account holder.
  private async issuerFor(playerId: string): Promise<string> {
    const player = await this.prisma.user.findUniqueOrThrow({
      where: { id: playerId },
      select: { agentId: true },
    });
    if (!player.agentId) throw new BadRequestException('That Player has no Agent');
    return player.agentId;
  }
}
