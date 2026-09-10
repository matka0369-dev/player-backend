-- In-system token requests: a Player asks for a balance change, someone in
-- their own hierarchy resolves it, and the resolution writes the ledger entry
-- in the same transaction.
--
-- TOP_UP is resolved by the Player's Agent out of the Agent's own wallet — an
-- ordinary AGENT_TRANSFER that moves supply already in existence.
--
-- SURRENDER is resolved by an Admin and DESTROYS the tokens (TOKEN_SURRENDER),
-- the exact mirror of ADMIN_GRANT creating them. Admin-tier for the same
-- reason minting is: changing total supply in either direction is one tier's
-- authority. Nothing leaves the system for value — there is no counterparty,
-- no payout destination, and no column anywhere here that could name one.
--
-- Note what this table deliberately does NOT have: no attachment, no external
-- transaction reference, no bank or payout details. A request is a message
-- about tokens inside the system, never evidence of anything outside it.
-- Screenshots remain confined to support_messages, structurally unrelated to
-- the ledger. See ARCHITECTURE.md "Hard safety boundaries".
ALTER TYPE "ledger_source" ADD VALUE 'TOKEN_SURRENDER';

CREATE TYPE "token_request_kind" AS ENUM ('TOP_UP', 'SURRENDER');
CREATE TYPE "token_request_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE "token_requests" (
    "id" TEXT NOT NULL,
    "requester_id" TEXT NOT NULL,
    "kind" "token_request_kind" NOT NULL,
    "status" "token_request_status" NOT NULL DEFAULT 'PENDING',
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "claimed_by_id" TEXT,
    "claimed_at" TIMESTAMP(3),
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution_note" TEXT,
    "ledger_entry_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_requests_pkey" PRIMARY KEY ("id")
);

-- A positive whole number, enforced here as well as in the DTO: the amount
-- feeds straight into a ledger delta, and a zero or negative request would
-- either be a no-op row or an inverted movement.
ALTER TABLE "token_requests" ADD CONSTRAINT "token_requests_amount_positive" CHECK ("amount" > 0);

CREATE UNIQUE INDEX "token_requests_ledger_entry_id_key" ON "token_requests"("ledger_entry_id");
CREATE INDEX "token_requests_requester_id_created_at_idx" ON "token_requests"("requester_id", "created_at");
CREATE INDEX "token_requests_status_kind_idx" ON "token_requests"("status", "kind");

ALTER TABLE "token_requests" ADD CONSTRAINT "token_requests_requester_id_fkey"
  FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "token_requests" ADD CONSTRAINT "token_requests_claimed_by_id_fkey"
  FOREIGN KEY ("claimed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "token_requests" ADD CONSTRAINT "token_requests_resolved_by_id_fkey"
  FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "token_requests" ADD CONSTRAINT "token_requests_ledger_entry_id_fkey"
  FOREIGN KEY ("ledger_entry_id") REFERENCES "token_ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Agent-side triage duty. Deliberately does NOT authorize approving a
-- TOP_UP: that moves the Agent's own tokens, and staff hold no token
-- authority anywhere in this hierarchy. A holder can claim, comment on, and
-- reject; only the native Agent can approve.
INSERT INTO "permissions" ("id", "key", "description")
VALUES (gen_random_uuid()::text, 'request:manage',
        'Triage token requests: claim and reject. Approving is the native Agent''s alone.')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "roles" ("id", "name", "description")
VALUES (gen_random_uuid()::text, 'Request Manager',
        'Works the token-request queue for an Agent: claims and rejects, never approves.')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id FROM "roles" r, "permissions" p
WHERE r.name = 'Request Manager' AND p.key = 'request:manage'
ON CONFLICT DO NOTHING;
