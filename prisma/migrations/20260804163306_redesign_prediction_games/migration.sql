-- CreateEnum
CREATE TYPE "prediction_type" AS ENUM ('OPEN_SINGLE', 'CLOSE_SINGLE', 'JODI', 'OPEN_SINGLE_PANA', 'CLOSE_SINGLE_PANA', 'OPEN_DOUBLE_PANA', 'CLOSE_DOUBLE_PANA', 'OPEN_TRIPLE_PANA', 'CLOSE_TRIPLE_PANA', 'HALF_SANGAM', 'FULL_SANGAM');

-- DropIndex
DROP INDEX "predictions_user_id_idx";

-- AlterTable
ALTER TABLE "games" DROP COLUMN "payout_multiplier",
ADD COLUMN     "close_time" TIME NOT NULL,
ADD COLUMN     "open_time" TIME NOT NULL,
ADD COLUMN     "weekly_off_days" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "predictions" DROP COLUMN "predicted_number",
ADD COLUMN     "cutoff_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "odds_multiplier" INTEGER NOT NULL,
ADD COLUMN     "picked_number" TEXT NOT NULL,
ADD COLUMN     "type_id" "prediction_type" NOT NULL;

-- AlterTable
ALTER TABLE "rounds" DROP COLUMN "result_at",
DROP COLUMN "winning_number",
ADD COLUMN     "close_pana" TEXT,
ADD COLUMN     "date" DATE NOT NULL,
ADD COLUMN     "open_pana" TEXT;

-- CreateTable
CREATE TABLE "game_holidays" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_enablements" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_enablements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "game_holidays_game_id_date_key" ON "game_holidays"("game_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "game_enablements_game_id_admin_id_key" ON "game_enablements"("game_id", "admin_id");

-- CreateIndex
CREATE INDEX "predictions_user_id_created_at_idx" ON "predictions"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "rounds_game_id_date_key" ON "rounds"("game_id", "date");

-- AddForeignKey
ALTER TABLE "game_holidays" ADD CONSTRAINT "game_holidays_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_enablements" ADD CONSTRAINT "game_enablements_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_enablements" ADD CONSTRAINT "game_enablements_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- DB-layer enforcement — the third of three independent layers (UI,
-- prediction-service/Go, here). Neither of the other two is trusted: this
-- layer re-derives everything from the stored round/type data itself, so a
-- bug or a bypass of the app layers still can't produce a malformed pick or
-- a late insert. See ARCHITECTURE.md "Prediction placement — triple layer
-- of checks".
-- ---------------------------------------------------------------------------

-- '0' sorts as if it were 10 — the domain's own ordering rule for a pana's
-- three digits, not a general-purpose helper.
CREATE OR REPLACE FUNCTION pana_digit_value(d TEXT) RETURNS INT AS $$
  SELECT CASE WHEN d = '0' THEN 10 ELSE d::INT END;
$$ LANGUAGE sql IMMUTABLE;

-- Structural validity only: 3 digits, non-decreasing under the ordering
-- above. Does not distinguish single/double/triple — those are mutually
-- exclusive by repeat pattern and each price differently (see rates), so
-- they get their own predicates below rather than being folded into one.
CREATE OR REPLACE FUNCTION is_valid_pana(p TEXT) RETURNS BOOLEAN AS $$
  SELECT
    p ~ '^[0-9]{3}$'
    AND pana_digit_value(substring(p, 1, 1)) <= pana_digit_value(substring(p, 2, 1))
    AND pana_digit_value(substring(p, 2, 1)) <= pana_digit_value(substring(p, 3, 1));
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION is_single_pana(p TEXT) RETURNS BOOLEAN AS $$
  SELECT is_valid_pana(p)
    AND substring(p,1,1) <> substring(p,2,1)
    AND substring(p,2,1) <> substring(p,3,1)
    AND substring(p,1,1) <> substring(p,3,1);
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION is_double_pana(p TEXT) RETURNS BOOLEAN AS $$
  SELECT is_valid_pana(p)
    AND NOT (
      substring(p,1,1) <> substring(p,2,1)
      AND substring(p,2,1) <> substring(p,3,1)
      AND substring(p,1,1) <> substring(p,3,1)
    )
    AND NOT (substring(p,1,1) = substring(p,2,1) AND substring(p,2,1) = substring(p,3,1));
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION is_triple_pana(p TEXT) RETURNS BOOLEAN AS $$
  SELECT is_valid_pana(p)
    AND substring(p,1,1) = substring(p,2,1)
    AND substring(p,2,1) = substring(p,3,1);
$$ LANGUAGE sql IMMUTABLE;

-- picked_number format per type_id.
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_picked_number_format" CHECK (
  (type_id IN ('OPEN_SINGLE', 'CLOSE_SINGLE') AND picked_number ~ '^[0-9]$')
  OR (type_id = 'JODI' AND picked_number ~ '^[0-9]{2}$')
  OR (type_id IN ('OPEN_SINGLE_PANA', 'CLOSE_SINGLE_PANA') AND is_single_pana(picked_number))
  OR (type_id IN ('OPEN_DOUBLE_PANA', 'CLOSE_DOUBLE_PANA') AND is_double_pana(picked_number))
  OR (type_id IN ('OPEN_TRIPLE_PANA', 'CLOSE_TRIPLE_PANA') AND is_triple_pana(picked_number))
  OR (type_id = 'HALF_SANGAM' AND (
    (picked_number ~ '^[0-9]-[0-9]{3}$' AND is_valid_pana(split_part(picked_number, '-', 2)))
    OR (picked_number ~ '^[0-9]{3}-[0-9]$' AND is_valid_pana(split_part(picked_number, '-', 1)))
  ))
  OR (type_id = 'FULL_SANGAM' AND picked_number ~ '^[0-9]{3}-[0-9]{3}$'
      AND is_valid_pana(split_part(picked_number, '-', 1))
      AND is_valid_pana(split_part(picked_number, '-', 2)))
);

-- Cutoff enforcement. Re-fetches the round row and recomputes the
-- authoritative cutoff from opens_at/closes_at itself rather than trusting
-- NEW.cutoff_at (which is application-supplied, kept only for audit
-- visibility) — a bug in the application's cutoff math, or a deliberately
-- spoofed value, still can't produce a late insert. One minute of buffer
-- before the relevant side's timestamp, matching every other layer. Every
-- close-side type is in the CLOSE_* list; everything else, including JODI
-- and both Sangams, is open-cutoff (explicit product decision, not a gap).
CREATE OR REPLACE FUNCTION enforce_prediction_cutoff() RETURNS TRIGGER AS $$
DECLARE
  r RECORD;
  cutoff TIMESTAMP(3);
BEGIN
  SELECT opens_at, closes_at, status INTO r FROM rounds WHERE id = NEW.round_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'round % does not exist', NEW.round_id;
  END IF;

  IF r.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'round % is cancelled', NEW.round_id;
  END IF;

  IF NEW.type_id IN ('CLOSE_SINGLE', 'CLOSE_SINGLE_PANA', 'CLOSE_DOUBLE_PANA', 'CLOSE_TRIPLE_PANA') THEN
    cutoff := r.closes_at - INTERVAL '1 minute';
  ELSE
    cutoff := r.opens_at - INTERVAL '1 minute';
  END IF;

  IF now() > cutoff THEN
    RAISE EXCEPTION 'prediction submitted after cutoff (% > %)', now(), cutoff;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER predictions_enforce_cutoff
  BEFORE INSERT ON "predictions"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_prediction_cutoff();
