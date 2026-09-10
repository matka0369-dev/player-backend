-- Two integrity gaps found by end-to-end validation (2026-08-22).
--
-- 1. A prediction could be inserted against a round whose result for that
--    side was already published. The stake was debited, but settlement only
--    ever runs from the result submission that is now refused as a
--    duplicate, so the row stayed PENDING permanently and the tokens were
--    destroyed with no counterparty. The cutoff trigger checked the clock
--    and CANCELLED, neither of which says anything about a published pana:
--    a result entered early, or for a future date, left the window
--    nominally open.
--
-- 2. games.close_time could precede games.open_time. The round generator
--    derives both instants from one date, so such a game produces rounds
--    whose closes_at falls ~22h BEFORE opens_at, making the close side
--    permanently unbettable with no error anywhere.

CREATE OR REPLACE FUNCTION enforce_prediction_cutoff() RETURNS TRIGGER AS $$
DECLARE
  r RECORD;
  cutoff TIMESTAMP(3);
  settled_pana TEXT;
BEGIN
  SELECT opens_at, closes_at, status, open_pana, close_pana
    INTO r FROM rounds WHERE id = NEW.round_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'round % does not exist', NEW.round_id;
  END IF;

  IF r.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'round % is cancelled', NEW.round_id;
  END IF;

  IF NEW.type_id IN ('CLOSE_SINGLE', 'CLOSE_SINGLE_PANA', 'CLOSE_DOUBLE_PANA', 'CLOSE_TRIPLE_PANA') THEN
    cutoff := r.closes_at - INTERVAL '1 minute';
    settled_pana := r.close_pana;
  ELSE
    cutoff := r.opens_at - INTERVAL '1 minute';
    settled_pana := r.open_pana;
  END IF;

  -- Checked before the clock: a published result closes the side outright,
  -- whatever opens_at/closes_at claim.
  IF settled_pana IS NOT NULL THEN
    RAISE EXCEPTION 'round % already has a result recorded for this side (%)', NEW.round_id, settled_pana;
  END IF;

  IF now() > cutoff THEN
    RAISE EXCEPTION 'prediction submitted after cutoff (% > %)', now(), cutoff;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Same-day windows only. An overnight game is not expressible today because
-- a Round derives opens_at and closes_at from a single date; supporting one
-- means rolling closes_at to the next day in the generator, which is a
-- deliberate feature rather than something to leave silently broken.
ALTER TABLE "games"
  ADD CONSTRAINT "games_close_after_open" CHECK ("close_time" > "open_time");
