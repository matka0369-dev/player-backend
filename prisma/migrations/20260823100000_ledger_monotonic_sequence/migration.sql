-- F-10: the ledger could not be read in the order things actually happened.
--
-- created_at is populated by now(), which in PostgreSQL is
-- transaction_timestamp() — the moment the transaction STARTED, not the
-- moment the row landed. Two transactions touching the same account
-- serialize on that account's row lock, so the one that started first can
-- commit second. Ordering a statement by created_at then shows rows in an
-- order where balance_after does not chain: observed in testing as a payout
-- of +9000 onto a balance of 9000 immediately followed by a reversal of
-- -9000 recording -1000, because a stake had landed in between despite
-- carrying a later timestamp.
--
-- For an append-only audit ledger that is the wrong failure: the numbers are
-- each correct, but the statement reads as if it does not add up, which is
-- exactly the moment someone is disputing it.
--
-- A sequence fixes the ordering because it is assigned at INSERT, and
-- applyDelta always inserts *after* the balance update it describes — so for
-- any single account, insert order is effect order (the row lock guarantees
-- it). created_at stays as-is: it is still the right answer to "when did this
-- happen", just not to "in what order".
ALTER TABLE "token_ledger_entries" ADD COLUMN "seq" BIGSERIAL NOT NULL;

CREATE UNIQUE INDEX "token_ledger_entries_seq_key" ON "token_ledger_entries"("seq");

-- Supports the per-account statement read, which is the hot path.
CREATE INDEX "token_ledger_entries_user_id_seq_idx" ON "token_ledger_entries"("user_id", "seq");
