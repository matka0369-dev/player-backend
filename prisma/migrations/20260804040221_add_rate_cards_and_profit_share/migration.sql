-- CreateEnum
CREATE TYPE "bet_type" AS ENUM ('SINGLE', 'JODI', 'SINGLE_PANA', 'DOUBLE_PANA', 'TRIPLE_PANA', 'HALF_SANGAM', 'FULL_SANGAM');

-- CreateEnum
CREATE TYPE "rate_kind" AS ENUM ('DEFAULT', 'GIVEN', 'GIVING');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "agent_share" INTEGER,
ADD COLUMN     "default_agent_share" INTEGER;

-- CreateTable
CREATE TABLE "rates" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "kind" "rate_kind" NOT NULL,
    "bet_type" "bet_type" NOT NULL,
    "multiplier" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rates_owner_id_kind_idx" ON "rates"("owner_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "rates_owner_id_kind_bet_type_key" ON "rates"("owner_id", "kind", "bet_type");

-- AddForeignKey
ALTER TABLE "rates" ADD CONSTRAINT "rates_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
