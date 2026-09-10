-- Admin <-> Agent settlements. Written when a result is entered, so the
-- dashboards read stored numbers instead of recomputing an aggregate on
-- every load. Not a token movement: signs are stored once from the Admin's
-- perspective and negated at read time for the Agent. See ARCHITECTURE.md
-- "Settlements" (2026-08-05).

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "agent_id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "open_pana" TEXT,
    "close_pana" TEXT,
    "total_staked" INTEGER NOT NULL,
    "total_payout" INTEGER NOT NULL,
    "net" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_lines" (
    "id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "type_id" "prediction_type" NOT NULL,
    "picked_number" TEXT NOT NULL,
    "stake" INTEGER NOT NULL,
    "agent_odds" INTEGER NOT NULL,
    "payout" INTEGER NOT NULL,

    CONSTRAINT "settlement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One row per agent per round: settlement recomputes and upserts on this,
-- because a game settles in two passes (open, then close) and the second
-- must correct the first rather than add a duplicate.
CREATE UNIQUE INDEX "settlements_round_id_agent_id_key" ON "settlements"("round_id", "agent_id");

-- CreateIndex
CREATE INDEX "settlements_admin_id_date_idx" ON "settlements"("admin_id", "date");

-- CreateIndex
CREATE INDEX "settlements_agent_id_date_idx" ON "settlements"("agent_id", "date");

-- CreateIndex
CREATE INDEX "settlement_lines_settlement_id_idx" ON "settlement_lines"("settlement_id");

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
