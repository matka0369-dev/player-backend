-- F-06: a published result could never be corrected.
--
-- Submitting a result was idempotent-by-refusal: a second submission for a
-- side that already had a pana returned 409. That is right for an accidental
-- repeat and wrong for a typo — winners were already paid, and there was no
-- path back. Since results are hand-entered by one person, it was the
-- failure most likely to actually happen.
--
-- Correction is a reversal, not an edit. Every payout the wrong result
-- created is clawed back with a compensating ledger row, every prediction on
-- the round goes back to PENDING, the Admin<->Agent settlement is discarded,
-- and the round is then graded again against the right numbers. The ledger
-- stays append-only throughout: nothing is deleted, the undo is recorded as
-- its own fact.
--
-- Note ALTER TYPE ... ADD VALUE is safe here only because nothing in this
-- migration writes the new value; PostgreSQL forbids using an enum value in
-- the same transaction that adds it.
ALTER TYPE "ledger_source" ADD VALUE 'RESULT_CORRECTION';

CREATE TABLE "result_corrections" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "previous_open_pana" TEXT,
    "previous_close_pana" TEXT,
    "new_open_pana" TEXT,
    "new_close_pana" TEXT,
    "predictions_reset" INTEGER NOT NULL,
    "payouts_reversed" INTEGER NOT NULL,
    "accounts_left_negative" INTEGER NOT NULL,
    "performed_by_id" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_corrections_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "result_corrections_round_id_idx" ON "result_corrections"("round_id");

ALTER TABLE "result_corrections"
  ADD CONSTRAINT "result_corrections_round_id_fkey"
  FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "result_corrections"
  ADD CONSTRAINT "result_corrections_performed_by_id_fkey"
  FOREIGN KEY ("performed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
