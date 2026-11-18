-- Agent employees get real duties, and everything they do is attributable.
--
-- The owner Agent no longer creates players or moves tokens itself: those move
-- to staff holding these permissions, so each action is tied to a person.

INSERT INTO "permissions" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'player:create', 'Create player accounts for the agent'),
  (gen_random_uuid()::text, 'token:transfer', 'Move the agent''s tokens to or from its players'),
  (gen_random_uuid()::text, 'request:approve', 'Approve or reject players'' token requests (moves the agent''s tokens)'),
  (gen_random_uuid()::text, 'prediction:view', 'View the agent''s players'' predictions, totals and ledger')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "roles" ("id", "name", "description") VALUES
  (gen_random_uuid()::text, 'Player Manager', 'Creates and moderates the agent''s players'),
  (gen_random_uuid()::text, 'Finance', 'Moves the agent''s tokens and approves token requests'),
  (gen_random_uuid()::text, 'Analyst', 'Read-only view of predictions, totals and reports')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id FROM "roles" r, "permissions" p
WHERE (r.name, p.key) IN (
  ('Player Manager', 'player:create'), ('Player Manager', 'moderation:manage'),
  ('Finance', 'token:transfer'), ('Finance', 'request:approve'), ('Finance', 'request:manage'),
  ('Analyst', 'prediction:view'), ('Analyst', 'report:view')
)
ON CONFLICT DO NOTHING;

-- Who did what. One row per notable action, naming the actual account that
-- acted (an employee, not just the Agent they work for).
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_type" TEXT,
    "action" TEXT NOT NULL,
    "target_user_id" TEXT,
    "target_type" TEXT,
    "target_id" TEXT,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_logs_owner_id_created_at_idx" ON "audit_logs"("owner_id", "created_at");
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
