import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LedgerSource, Prisma, TokenRequestKind, TokenRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { PERMISSIONS } from '../rbac/permissions.constants';
import { effectiveTier, resolveScopeOwnerId } from '../rbac/scope.util';
import { CreateTokenRequestDto, ResolveTokenRequestDto } from './dto/create-request.dto';
import { IMAGE_RETENTION_MS, parseImageDataUrl } from './image-data-url.util';

const requestSelect = {
  id: true,
  kind: true,
  status: true,
  amount: true,
  note: true,
  // Not imageData — that's the full decoded bytes and has no business in a
  // list response. Its presence is all a row needs to say; the actual
  // bytes are fetched on demand via getImage, one request at a time.
  imageMimeType: true,
  claimedAt: true,
  resolvedAt: true,
  resolutionNote: true,
  createdAt: true,
  requester: { select: { id: true, username: true, agentId: true } },
  claimedBy: { select: { id: true, username: true } },
  resolvedBy: { select: { id: true, username: true } },
  ledgerEntryId: true,
} as const;

@Injectable()
export class RequestsService {
  private readonly logger = new Logger(RequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
  ) {}

  /**
   * A Player asking for a balance change.
   *
   * One open request per kind at a time. Without that, a Player could queue
   * five identical top-ups and a distracted reviewer could approve each of
   * them — the queue is worked by humans, so the duplicate has to be
   * impossible rather than merely discouraged.
   */
  async create(dto: CreateTokenRequestDto, requester: AuthenticatedUser) {
    if (requester.accountType !== 'PLAYER') {
      throw new ForbiddenException('Only a Player may raise a token request');
    }

    const player = await this.prisma.user.findUnique({
      where: { id: requester.id },
      select: { agentId: true, balance: true, winningsBalance: true },
    });
    if (!player?.agentId) throw new BadRequestException('Your account has no agent');

    // Checked at creation as a courtesy so the Player finds out now rather
    // than after a reviewer has spent time on it. Re-checked at approval,
    // which is the moment that actually matters — the balance can move in
    // between, and the ledger's own guard is the authority either way.
    if (dto.kind === TokenRequestKind.SURRENDER) {
      const held = player.balance + player.winningsBalance;
      if (dto.amount > held) {
        throw new BadRequestException(`You only hold ${held} tokens`);
      }
    }

    const open = await this.prisma.tokenRequest.count({
      where: { requesterId: requester.id, kind: dto.kind, status: TokenRequestStatus.PENDING },
    });
    if (open > 0) {
      throw new ConflictException(`You already have a pending ${dto.kind} request`);
    }

    // Already validated well-formed and under the size cap by the DTO;
    // parsed again here rather than trusting a value that crossed a
    // process boundary in between.
    const image = dto.image ? parseImageDataUrl(dto.image) : null;

    return this.prisma.tokenRequest.create({
      data: {
        requesterId: requester.id,
        kind: dto.kind,
        amount: dto.amount,
        note: dto.note,
        // Cast, not a real type hole: TS's DOM lib types Uint8Array generic
        // over ArrayBufferLike (which admits SharedArrayBuffer) since 5.7,
        // but parseImageDataUrl only ever produces one backed by a plain
        // ArrayBuffer, which is all Prisma's Bytes columns accept.
        imageData: image?.buffer as Uint8Array<ArrayBuffer> | undefined,
        imageMimeType: image?.mimeType,
      },
      select: requestSelect,
    });
  }

  /** A Player withdrawing their own request before anyone acts on it. */
  async cancel(id: string, requester: AuthenticatedUser) {
    const done = await this.prisma.tokenRequest.updateMany({
      where: { id, requesterId: requester.id, status: TokenRequestStatus.PENDING },
      data: { status: TokenRequestStatus.CANCELLED },
    });
    if (done.count === 0) {
      throw new ConflictException('That request is not yours, or is no longer pending');
    }
    return this.prisma.tokenRequest.findUniqueOrThrow({ where: { id }, select: requestSelect });
  }

  /** A Player's own history. */
  async mine(requester: AuthenticatedUser) {
    return this.prisma.tokenRequest.findMany({
      where: { requesterId: requester.id },
      orderBy: { createdAt: 'desc' },
      select: requestSelect,
    });
  }

  /**
   * The queue, scoped the same way every other read in this API is.
   *
   * An Agent (and its staff) sees requests from its own Players. An Admin
   * (and its staff) sees the whole subtree — it has to, because SURRENDER is
   * resolved at Admin tier. Platform Admin sees nothing: it provisions
   * Admins and has no token authority anywhere.
   */
  async queue(requester: AuthenticatedUser, status?: TokenRequestStatus) {
    const ownerId = resolveScopeOwnerId(requester);
    const tier = effectiveTier(requester);
    let where: Prisma.TokenRequestWhereInput;

    if (tier === 'AGENT') {
      where = { requester: { agentId: ownerId } };
    } else if (tier === 'ADMIN') {
      const agents = await this.prisma.user.findMany({
        where: { accountType: 'AGENT', createdById: ownerId },
        select: { id: true },
      });
      where = { requester: { agentId: { in: agents.map((a) => a.id) } } };
    } else {
      return [];
    }

    if (status) where.status = status;

    return this.prisma.tokenRequest.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      select: requestSelect,
    });
  }

  /**
   * Take ownership of a pending request so other reviewers can see it is
   * being worked.
   *
   * Conditional on `claimedById IS NULL`, so two reviewers pressing at once
   * produce one winner and one 409 rather than a silently overwritten
   * claimant. Advisory only — it does not gate resolution, which has its own
   * guard; a claim that blocked resolution would just mean a reviewer who
   * went to lunch could freeze someone else's queue.
   */
  async claim(id: string, requester: AuthenticatedUser) {
    const req = await this.loadInScope(id, requester);
    this.assertMayTriage(requester);
    if (req.status !== TokenRequestStatus.PENDING) {
      throw new ConflictException('That request has already been resolved');
    }
    const done = await this.prisma.tokenRequest.updateMany({
      where: { id, status: TokenRequestStatus.PENDING, claimedById: null },
      data: { claimedById: requester.id, claimedAt: new Date() },
    });
    if (done.count === 0) {
      throw new ConflictException('Someone else is already working on that request');
    }
    return this.prisma.tokenRequest.findUniqueOrThrow({ where: { id }, select: requestSelect });
  }

  /** Release a claim without resolving, so the request returns to the queue. */
  async release(id: string, requester: AuthenticatedUser) {
    await this.loadInScope(id, requester);
    this.assertMayTriage(requester);
    const done = await this.prisma.tokenRequest.updateMany({
      where: { id, status: TokenRequestStatus.PENDING, claimedById: requester.id },
      data: { claimedById: null, claimedAt: null },
    });
    if (done.count === 0) throw new ConflictException('You do not hold that claim');
    return this.prisma.tokenRequest.findUniqueOrThrow({ where: { id }, select: requestSelect });
  }

  /**
   * Reject a request. Moves no tokens, which is exactly why staff may do it.
   */
  async reject(id: string, dto: ResolveTokenRequestDto, requester: AuthenticatedUser) {
    const req = await this.loadInScope(id, requester);
    this.assertMayTriage(requester);

    const done = await this.prisma.tokenRequest.updateMany({
      where: { id, status: TokenRequestStatus.PENDING },
      data: {
        status: TokenRequestStatus.REJECTED,
        resolvedById: requester.id,
        resolvedAt: new Date(),
        resolutionNote: dto.resolutionNote,
      },
    });
    if (done.count === 0) throw new ConflictException('That request is no longer pending');
    void req;
    return this.prisma.tokenRequest.findUniqueOrThrow({ where: { id }, select: requestSelect });
  }

  /**
   * Approve a request and perform the movement it asked for, atomically.
   *
   * The status flip is a **conditional update on `status = PENDING` inside
   * the same transaction as the ledger write**. That is what makes a
   * double-approve impossible: if two reviewers race, the second finds zero
   * rows to update, throws, and its transaction rolls back — so the tokens
   * move exactly once or not at all. Checking-then-writing would leave a
   * window between the two where both callers believed they had the request.
   *
   * Authority differs by kind, and neither is delegable to staff:
   *   TOP_UP    — the Player's own Agent, moving its own tokens.
   *   SURRENDER — an Admin, destroying supply (mirror of minting).
   */
  async approve(id: string, dto: ResolveTokenRequestDto, requester: AuthenticatedUser) {
    const req = await this.loadInScope(id, requester);
    if (req.status !== TokenRequestStatus.PENDING) {
      throw new ConflictException('That request has already been resolved');
    }

    // Staff triage; they never approve. Stated as its own check with its own
    // message so a Request Manager hitting this understands the boundary
    // rather than reading it as a missing role.
    if (requester.accountType === 'AGENT_STAFF' || requester.accountType === 'ADMIN_STAFF') {
      throw new ForbiddenException(
        'Staff can claim and reject requests, but approving moves tokens — that is the account holder\'s alone',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Claim the row first. Everything below only runs for the caller that
      // actually flipped it.
      const claimed = await tx.tokenRequest.updateMany({
        where: { id, status: TokenRequestStatus.PENDING },
        data: {
          status: TokenRequestStatus.APPROVED,
          resolvedById: requester.id,
          resolvedAt: new Date(),
          resolutionNote: dto.resolutionNote,
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException('That request was resolved by someone else');
      }

      let entryId: string;

      if (req.kind === TokenRequestKind.TOP_UP) {
        if (requester.accountType !== 'AGENT' || req.requester.agentId !== requester.id) {
          throw new ForbiddenException('Only this Player\'s own Agent may approve a top-up');
        }
        // Both legs of the paired transfer, inside this transaction: the
        // Agent's wallet down, the Player's up. applyDelta's overdraft guard
        // on the debit leg is what stops an Agent approving more than it
        // holds — and because it runs here, failing rolls back the approval
        // too rather than leaving a request marked APPROVED with no movement.
        await this.ledgerService.applyDelta(tx, {
          userId: requester.id,
          delta: -req.amount,
          source: LedgerSource.AGENT_TRANSFER,
          performedById: requester.id,
          note: `Top-up request from ${req.requester.username}`,
        });
        const credit = await this.ledgerService.applyDelta(tx, {
          userId: req.requester.id,
          delta: req.amount,
          source: LedgerSource.AGENT_TRANSFER,
          performedById: requester.id,
          note: dto.resolutionNote ?? 'Approved top-up request',
        });
        entryId = credit.id;
      } else {
        // SURRENDER — Admin tier, same gate as minting, opposite direction.
        await this.ledgerService.assertMaySetSupply(req.requester.id, requester);
        const burn = await this.ledgerService.surrender(tx, {
          userId: req.requester.id,
          amount: req.amount,
          performedById: requester.id,
          note: dto.resolutionNote ?? `Surrendered ${req.amount} tokens`,
        });
        entryId = burn.id;
      }

      await tx.tokenRequest.update({ where: { id }, data: { ledgerEntryId: entryId } });
      return tx.tokenRequest.findUniqueOrThrow({ where: { id }, select: requestSelect });
    });
  }

  /**
   * The one image a request may carry, if it has one. Same audience as the
   * request itself: the Player who attached it, or a reviewer who already
   * has that request in scope — never anyone else. 404 either way a caller
   * isn't entitled, matching loadInScope's "existence isn't information the
   * caller is owed."
   */
  async getImage(id: string, requester: AuthenticatedUser): Promise<{ data: Uint8Array; mimeType: string }> {
    const req = await this.prisma.tokenRequest.findUnique({
      where: { id },
      select: {
        requesterId: true,
        imageData: true,
        imageMimeType: true,
        requester: { select: { agentId: true } },
      },
    });
    if (!req?.imageData || !req.imageMimeType) {
      throw new NotFoundException('Request or image not found');
    }

    const isOwner = requester.id === req.requesterId;
    if (!isOwner && !(await this.isInReviewerScope(req.requester.agentId, requester))) {
      throw new NotFoundException('Request or image not found');
    }

    return { data: req.imageData, mimeType: req.imageMimeType };
  }

  /**
   * Clears imageData/imageMimeType off any request whose image has outlived
   * IMAGE_RETENTION_MS (15 days from when it was raised) — never the row
   * itself. Once cleared, getImage 404s the same way a request that never
   * had an image does; there's no separate "expired" state to model.
   *
   * Runs daily rather than precisely at the 15-day mark: a few hours of
   * slack on a retention window measured in days isn't worth a per-row
   * timer, and this only ever narrows what's stored, never what's kept.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async purgeExpiredImages(): Promise<void> {
    const cutoff = new Date(Date.now() - IMAGE_RETENTION_MS);
    const { count } = await this.prisma.tokenRequest.updateMany({
      where: { imageData: { not: null }, createdAt: { lt: cutoff } },
      data: { imageData: null, imageMimeType: null },
    });
    if (count > 0) {
      this.logger.log(`Purged ${count} token-request image(s) past the retention window`);
    }
  }

  /** Whether `requester` is a reviewer whose scope covers a request raised
   *  by a Player under the given Agent — the same rule loadInScope enforces,
   *  factored out so getImage can't drift from it. */
  private async isInReviewerScope(
    requesterAgentId: string | null,
    requester: AuthenticatedUser,
  ): Promise<boolean> {
    const ownerId = resolveScopeOwnerId(requester);
    const tier = effectiveTier(requester);

    if (tier === 'AGENT') {
      return requesterAgentId === ownerId;
    }
    if (tier === 'ADMIN') {
      const owned = await this.prisma.user.count({
        where: { id: requesterAgentId ?? '', createdById: ownerId },
      });
      return owned > 0;
    }
    return false;
  }

  private assertMayTriage(requester: AuthenticatedUser) {
    const native = requester.accountType === 'AGENT' || requester.accountType === 'ADMIN';
    if (native) return;
    if (!requester.permissions.includes(PERMISSIONS.REQUEST_MANAGE)) {
      throw new ForbiddenException(`Missing required permission: ${PERMISSIONS.REQUEST_MANAGE}`);
    }
  }

  /**
   * Load a request the caller is entitled to see at all. 404 rather than 403
   * for someone else's, matching the rest of the API — existence isn't
   * information the caller is owed.
   */
  private async loadInScope(id: string, requester: AuthenticatedUser) {
    const tier = effectiveTier(requester);
    if (tier !== 'AGENT' && tier !== 'ADMIN') {
      throw new ForbiddenException('Your account type cannot review token requests');
    }

    const req = await this.prisma.tokenRequest.findUnique({
      where: { id },
      select: {
        id: true,
        kind: true,
        status: true,
        amount: true,
        requester: { select: { id: true, username: true, agentId: true } },
      },
    });
    if (!req) throw new NotFoundException('Request not found');

    if (!(await this.isInReviewerScope(req.requester.agentId, requester))) {
      throw new NotFoundException('Request not found');
    }

    return req;
  }
}
