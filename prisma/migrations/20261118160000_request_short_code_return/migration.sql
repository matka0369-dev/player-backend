-- Token requests get a short, typo-proof code that travels in the WhatsApp
-- message (so an Agent can paste the message and land on the exact request),
-- and a RETURN kind: a player giving tokens back to their Agent's wallet.
ALTER TYPE "token_request_kind" ADD VALUE 'RETURN';

ALTER TABLE "token_requests" ADD COLUMN "short_code" TEXT;
UPDATE "token_requests" SET "short_code" = upper(substr(md5("id"), 1, 8)) WHERE "short_code" IS NULL;
CREATE UNIQUE INDEX "token_requests_short_code_key" ON "token_requests"("short_code");
