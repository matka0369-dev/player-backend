-- Second wallet for Players (settlement pays into it), the Agent-transfer
-- and stake-in ledger sources, and the admin->agent odds recorded alongside
-- the agent->player odds on every prediction. See ARCHITECTURE.md
-- "Results, settlement, and the winnings wallet" (2026-08-05).

-- CreateEnum
CREATE TYPE "ledger_wallet" AS ENUM ('MAIN', 'WINNINGS');

-- AlterEnum
-- Safe in one migration on PostgreSQL 12+ (this project runs 17) because
-- neither new value is *used* in this same transaction — only declared.
ALTER TYPE "ledger_source" ADD VALUE 'AGENT_TRANSFER';
ALTER TYPE "ledger_source" ADD VALUE 'PREDICTION_STAKE_IN';

-- AlterTable
-- DEFAULT 0 rather than nullable: every prediction placed from here on
-- fills this in, and rows predating it genuinely had no recorded
-- admin->agent rate. 0 reads as "not recorded" without inventing a number.
ALTER TABLE "predictions" ADD COLUMN     "agent_odds_multiplier" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
-- Every pre-existing ledger row moved the main wallet, so backfilling the
-- default to MAIN is correct rather than merely convenient.
ALTER TABLE "token_ledger_entries" ADD COLUMN     "wallet" "ledger_wallet" NOT NULL DEFAULT 'MAIN';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "winnings_balance" INTEGER NOT NULL DEFAULT 0;
