import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { resolveScopeOwnerId } from '../rbac/scope.util';

export interface AuditEvent {
  action: string;
  targetUserId?: string | null;
  targetType?: string;
  targetId?: string;
  meta?: Record<string, unknown>;
}

type Db = Prisma.TransactionClient | PrismaService;

/**
 * The activity log. `record` names the account that actually acted — an
 * employee's own id, not the Agent they work for — and files the row under the
 * subtree owner (the Agent) so it shows up in that Agent's Activity log.
 *
 * Pass the surrounding transaction as `db` when the action writes money or
 * balances: the log row then commits or rolls back with the action itself.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  record(actor: AuthenticatedUser, event: AuditEvent, db: Db = this.prisma) {
    return db.auditLog.create({
      data: {
        ownerId: resolveScopeOwnerId(actor),
        actorId: actor.id,
        actorType: actor.accountType,
        action: event.action,
        targetUserId: event.targetUserId ?? null,
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        meta: (event.meta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  /** The owner's own log, newest first, with optional filters. */
  async list(
    owner: AuthenticatedUser,
    q: { actorId?: string; action?: string; from?: string; to?: string; limit?: number },
  ) {
    const ownerId = resolveScopeOwnerId(owner);
    const where: Prisma.AuditLogWhereInput = { ownerId };
    if (q.actorId) where.actorId = q.actorId;
    if (q.action) where.action = { startsWith: q.action };
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lt: new Date(new Date(q.to).getTime() + 86_400_000) } : {}),
      };
    }
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(q.limit ?? 200, 1), 500),
      include: {
        actor: { select: { id: true, username: true, accountType: true } },
      },
    });

    // Resolve the player a row is about without a join per row.
    const targetIds = [...new Set(rows.map((r) => r.targetUserId).filter((x): x is string => !!x))];
    const targets = targetIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: targetIds } }, select: { id: true, username: true } })
      : [];
    const byId = new Map(targets.map((t) => [t.id, t.username]));
    return rows.map((r) => ({
      id: r.id,
      at: r.createdAt,
      action: r.action,
      actor: r.actor ? { id: r.actor.id, username: r.actor.username, type: r.actor.accountType } : null,
      target: r.targetUserId ? { id: r.targetUserId, username: byId.get(r.targetUserId) ?? null } : null,
      meta: r.meta,
    }));
  }
}
