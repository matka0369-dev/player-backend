-- A Player may attach one image to a token request — see ARCHITECTURE.md
-- "Hard safety boundaries" (2026-09-15 revision) for the explicit sign-off
-- behind this and what it deliberately does not do.
ALTER TABLE "token_requests" ADD COLUMN "image_data" BYTEA;
ALTER TABLE "token_requests" ADD COLUMN "image_mime_type" TEXT;
