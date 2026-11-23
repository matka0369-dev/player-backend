-- Backs out 20261123120000_settlement_agent_share. Profit and loss are not split
-- by a percentage: each tier loses at its own rate (the Admin at the rate it
-- gives the Agent, the Agent at the rate it gives its players), and the
-- settlement between them stays the plain mirror. Nothing wrote a non-zero
-- value to this column, so dropping it loses nothing.
ALTER TABLE "settlements" DROP CONSTRAINT IF EXISTS "settlements_agent_share_range";
ALTER TABLE "settlements" DROP COLUMN IF EXISTS "agent_share";
