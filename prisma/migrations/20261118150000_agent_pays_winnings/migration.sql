-- A winner's payout is now funded by their Agent's wallet (the debit leg of
-- the pair; the player-side credit stays PREDICTION_PAYOUT).
ALTER TYPE "ledger_source" ADD VALUE 'AGENT_PAYOUT';
