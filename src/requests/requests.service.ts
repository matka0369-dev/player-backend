import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LedgerSource, LedgerWallet, Prisma, TokenRequestKind, TokenRequestStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { PERMISSIONS } from '../rbac/permissions.constants';
import { effectiveTier, resolveScopeOwnerId } from '../rbac/scope.util';
import { CreateTokenRequestDto, ResolveTokenRequestDto } from './dto/create-request.dto';
import { generateShortCode, normalizeShortCode } from './short-code.util';
import { IMAGE_RETENTION_MS, parseImageDataUrl } from './image-data-url.util';

const requestSelect = {
  id: true,
  shortCode: true,
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
    private readonly audit: AuditService,
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
    if (dto.kind === TokenRequestKind.SURRENDER || dto.kind === TokenRequestKind.RETURN) {
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

    // A clash on the short code is astronomically unlikely, but it is a unique
    // index — retry rather than surface a 500 the Player can do nothing about.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.createRow(dto, requester.id, image, generateShortCode());
      } catch (e) {
        const clash = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && String(e.meta?.target).includes('short_code');
        if (!clash || attempt >= 4) throw e;
      }
    }
  }

  private createRow(
    dto: CreateTokenRequestDto,
    requesterId: string,
    image: ReturnType<typeof parseImageDataUrl>,
    shortCode: string,
  ) {
    return this.prisma.tokenRequest.create({
      data: {
        requesterId,
        shortCode,
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
    await this.audit.record(requester, { action: 'request.claim', targetType: 'token_request', targetId: id });
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
    await this.audit.record(requester, {
      action: 'request.reject', targetUserId: req.requester.id, targetType: 'token_request', targetId: id,
      meta: { kind: req.kind, amount: req.amount },
    });
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

    // Who may approve: an Agent's top-up is approved by an Agent *employee*
    // holding request:approve (2026-11-18) — never the owner account, so the
    // approval is attributable. A surrender is the native Admin's alone.
    if (requester.accountType === 'ADMIN_STAFF') {
      throw new ForbiddenException('Admin staff can claim and reject requests; approving is the Admin\'s alone');
    }
    if (requester.accountType === 'AGENT') {
      throw new ForbiddenException(
        'Approving moves the agent\'s tokens, so it needs a staff account with the Finance role (request:approve)',
      );
    }
    if (requester.accountType === 'AGENT_STAFF') {
      if (!requester.permissions.includes(PERMISSIONS.REQUEST_APPROVE)) {
        throw new ForbiddenException(`Missing required permission: ${PERMISSIONS.REQUEST_APPROVE}`);
      }
      if (req.kind === TokenRequestKind.SURRENDER) {
        throw new ForbiddenException('Only an Admin approves a surrender');
      }
    }
    const ownerId = resolveScopeOwnerId(requester);

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
        if (requester.accountType !== 'AGENT_STAFF' || req.requester.agentId !== ownerId) {
          throw new ForbiddenException('Only this Player\'s own Agent\'s staff may approve a top-up');
        }
        // Both legs of the paired transfer, inside this transaction: the
        // Agent's wallet down, the Player's up. applyDelta's overdraft guard
        // on the debit leg is what stops an Agent approving more than it
        // holds — and because it runs here, failing rolls back the approval
        // too rather than leaving a request marked APPROVED with no movement.
        await this.ledgerService.applyDelta(tx, {
          userId: ownerId,
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
      } else if (req.kind === TokenRequestKind.RETURN) {
        // The Player gives tokens back to its own Agent. Same staff gate as a
        // top-up; the movement is the mirror image.
        if (requester.accountType !== 'AGENT_STAFF' || req.requester.agentId !== ownerId) {
          throw new ForbiddenException('Only this Player\'s own Agent\'s staff may approve a return');
        }
        const held = await tx.user.findUniqueOrThrow({
          where: { id: req.requester.id },
          select: { balance: true, winningsBalance: true },
        });
        if (held.balance + held.winningsBalance < req.amount) {
          throw new ConflictException('The player no longer holds that many tokens');
        }
        // Main wallet first, then winnings — the same order stakes draw down.
        const fromMain = Math.min(Math.max(held.balance, 0), req.amount);
        const fromWinnings = req.amount - fromMain;
        const note = dto.resolutionNote ?? `Returned to agent (request ${req.requester.username})`;
        if (fromMain > 0) {
          await this.ledgerService.applyDelta(tx, {
            userId: req.requester.id, delta: -fromMain, wallet: LedgerWallet.MAIN,
            source: LedgerSource.AGENT_TRANSFER, performedById: requester.id, note,
          });
        }
        if (fromWinnings > 0) {
          await this.ledgerService.applyDelta(tx, {
            userId: req.requester.id, delta: -fromWinnings, wallet: LedgerWallet.WINNINGS,
            source: LedgerSource.AGENT_TRANSFER, performedById: requester.id, note,
          });
        }
        const credit = await this.ledgerService.applyDelta(tx, {
          userId: ownerId, delta: req.amount, wallet: LedgerWallet.MAIN,
          source: LedgerSource.AGENT_TRANSFER, performedById: requester.id,
          note: `Return from ${req.requester.username}`,
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
      await this.audit.record(
        requester,
        { action: 'request.approve', targetUserId: req.requester.id, targetType: 'token_request', targetId: id, meta: { kind: req.kind, amount: req.amount } },
        tx,
      );
      return tx.tokenRequest.findUniqueOrThrow({ where: { id }, select: requestSelect });
    });
  }

  /**
   * Find a request by the short code a Player's WhatsApp message carries.
   * Only the code locates it: the stored row is the truth, and nothing from
   * the pasted text (amount, kind) is trusted. 404 for a code outside the
   * caller's scope, same as every other lookup here.
   */
  async lookup(code: string, requester: AuthenticatedUser) {
    const tier = effectiveTier(requester);
    if (tier !== 'AGENT' && tier !== 'ADMIN') {
      throw new ForbiddenException('Your account type cannot review token requests');
    }
    this.assertMayTriage(requester);
    const found = await this.prisma.tokenRequest.findUnique({
      where: { shortCode: normalizeShortCode(code) },
      select: requestSelect,
    });
    if (!found || !(await this.isInReviewerScope(found.requester.agentId, requester))) {
      throw new NotFoundException('No request with that code in your queue');
    }
    return found;
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
