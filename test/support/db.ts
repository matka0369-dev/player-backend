import { PrismaClient } from '@prisma/client';

/** Direct access to the throwaway test database, for asserting on stored state. */
export function testPrisma(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
}
