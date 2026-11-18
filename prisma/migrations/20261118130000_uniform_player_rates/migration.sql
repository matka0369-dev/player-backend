-- Every Player now plays at its Agent's GIVING card; per-Player (PLAYING)
-- override rows are no longer read or written. The enum value stays (Postgres
-- can't safely drop one), only the rows go.
DELETE FROM "rates" WHERE "kind" = 'PLAYING';
