// Bootstraps the platform: permission keys, starter roles, and the one
// Platform Admin account needed to create everything else (nothing else can
// create the first account — see ARCHITECTURE.md hierarchy).
import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS = [
  { key: 'user:manage', description: 'Create/deactivate Player accounts, assign Players to Agents, assign roles' },
  { key: 'agent:manage', description: 'Create/deactivate Agent accounts' },
  { key: 'token:administer', description: 'Grant tokens to a user (ADMIN_GRANT ledger entries)' },
  { key: 'game:manage', description: 'Create/configure games and rounds' },
  { key: 'report:view', description: 'View reporting/dashboards' },
  { key: 'moderation:manage', description: 'Activate/deactivate accounts, handle support messages' },
  { key: 'rate:manage', description: "Edit your own payout card (an Admin's default, or an Agent's giving rates)" },
];

const ROLES: { name: string; description: string; permissionKeys: string[] }[] = [
  { name: 'User Manager', description: 'Manages Player accounts and role assignment', permissionKeys: ['user:manage'] },
  { name: 'Agent Manager', description: 'Manages Agent accounts', permissionKeys: ['agent:manage'] },
  { name: 'Token Manager', description: 'Grants tokens (audited)', permissionKeys: ['token:administer'] },
  { name: 'Game Manager', description: 'Configures prediction games', permissionKeys: ['game:manage'] },
  { name: 'Reporting', description: 'Read-only reporting access', permissionKeys: ['report:view'] },
  { name: 'Moderator', description: 'Account moderation and support handling', permissionKeys: ['moderation:manage'] },
  { name: 'Rate Manager', description: 'Edits payout rate cards', permissionKeys: ['rate:manage'] },
];

// Bet types and their house multipliers, mirrored from src/rates/rates.constants.ts.
// Kept in sync by hand because the seed can't import from src/ under ts-node's
// isolated config — if you change one, change the other.
const DEFAULT_RATES: Record<string, number> = {
  SINGLE: 9,
  JODI: 90,
  SINGLE_PANA: 140,
  DOUBLE_PANA: 280,
  TRIPLE_PANA: 600,
  HALF_SANGAM: 1400,
  FULL_SANGAM: 10000,
};

async function main() {
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { description: p.description },
      create: p,
    });
  }

  for (const r of ROLES) {
    const role = await prisma.role.upsert({
      where: { name: r.name },
      update: { description: r.description },
      create: { name: r.name, description: r.description },
    });

    for (const key of r.permissionKeys) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }

  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (!bootstrapEmail || !bootstrapPassword) {
    console.warn(
      'BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD not set — skipping Platform Admin creation. ' +
        'Set them in .env and re-run `npx prisma db seed` to create the first account.',
    );
  } else {
    const existing = await prisma.user.findFirst({ where: { email: bootstrapEmail } });
    if (existing) {
      console.log(`Platform Admin ${bootstrapEmail} already exists, skipping.`);
    } else {
      const passwordHash = await bcrypt.hash(bootstrapPassword, 12);
      await prisma.user.create({
        data: {
          email: bootstrapEmail,
          username: 'platform_admin',
          passwordHash,
          accountType: 'PLATFORM_ADMIN',
        },
      });
      console.log(`Created Platform Admin: ${bootstrapEmail}`);
    }
  }

  await backfillRateCards();

  console.log('Seed complete.');
}

/**
 * Accounts created before rate cards existed have none, which would leave an
 * Agent unable to price anything and an Admin with no template to hand down.
 * Idempotent: only fills in cards that are missing.
 */
async function backfillRateCards() {
  const admins = await prisma.user.findMany({
    where: { accountType: 'ADMIN' },
    select: { id: true, username: true, defaultAgentShare: true },
  });

  for (const admin of admins) {
    const has = await prisma.rate.count({ where: { ownerId: admin.id, kind: 'DEFAULT' } });
    if (has === 0) {
      await prisma.rate.createMany({
        data: Object.entries(DEFAULT_RATES).map(([betType, multiplier]) => ({
          ownerId: admin.id,
          kind: 'DEFAULT' as const,
          betType: betType as never,
          multiplier,
        })),
      });
      console.log(`Backfilled DEFAULT card for admin ${admin.username}`);
    }
    if (admin.defaultAgentShare === null) {
      await prisma.user.update({ where: { id: admin.id }, data: { defaultAgentShare: 1 } });
    }
  }

  const agents = await prisma.user.findMany({
    where: { accountType: 'AGENT' },
    select: { id: true, username: true, createdById: true, agentShare: true },
  });

  for (const agent of agents) {
    const has = await prisma.rate.count({ where: { ownerId: agent.id } });
    if (has === 0) {
      // Inherit the owning Admin's template where there is one, else house.
      const template = agent.createdById
        ? await prisma.rate.findMany({ where: { ownerId: agent.createdById, kind: 'DEFAULT' } })
        : [];
      const source = template.length
        ? template.map((r) => [r.betType as string, r.multiplier] as const)
        : Object.entries(DEFAULT_RATES);

      await prisma.rate.createMany({
        data: source.flatMap(([betType, multiplier]) => [
          { ownerId: agent.id, kind: 'GIVEN' as const, betType: betType as never, multiplier },
          { ownerId: agent.id, kind: 'GIVING' as const, betType: betType as never, multiplier },
        ]),
      });
      console.log(`Backfilled GIVEN/GIVING cards for agent ${agent.username}`);
    }
    if (agent.agentShare === null) {
      await prisma.user.update({ where: { id: agent.id }, data: { agentShare: 1 } });
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
