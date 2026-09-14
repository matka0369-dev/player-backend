-- Email/phone is no longer globally unique: a Player's is only checked for
-- collisions within its creating Admin's own subtree (app-level, see
-- UsersService.create). Two different Admins are independent businesses, so
-- the same phone number legitimately playing under both is not a collision.
-- Replaced with a plain index so lookups and the phone-search filter stay
-- fast without reintroducing a global constraint.
DROP INDEX "users_email_key";

CREATE INDEX "users_email_idx" ON "users"("email");
