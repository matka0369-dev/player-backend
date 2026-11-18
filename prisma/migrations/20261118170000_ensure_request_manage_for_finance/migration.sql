-- The Finance role (20261118140000) must be able to open the token-request
-- queue, which is gated on request:manage. On a database where that
-- permission row didn't exist when 20261118140000 ran, the role_permissions
-- insert silently matched nothing and Finance staff got "Missing required
-- permission: request:manage". Create the permission if it's absent and make
-- sure Finance holds it. Safe to re-run: every statement is a no-op when the
-- rows are already there.

INSERT INTO "permissions" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'request:manage', 'View and work the token request queue')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id FROM "roles" r, "permissions" p
WHERE r.name = 'Finance' AND p.key = 'request:manage'
ON CONFLICT DO NOTHING;
