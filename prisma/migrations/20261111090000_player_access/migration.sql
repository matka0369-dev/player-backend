-- QR/link + PIN sign-in for Players, and the Agent contact fields that feed
-- the Register-on-WhatsApp button. See ARCHITECTURE.md "Player access".

ALTER TABLE "users" ADD COLUMN "whatsapp_number" TEXT;
ALTER TABLE "users" ADD COLUMN "invite_code" TEXT;
CREATE UNIQUE INDEX "users_invite_code_key" ON "users"("invite_code");

CREATE TABLE "login_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "login_tokens_token_hash_key" ON "login_tokens"("token_hash");
CREATE INDEX "login_tokens_user_id_idx" ON "login_tokens"("user_id");
ALTER TABLE "login_tokens" ADD CONSTRAINT "login_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "login_tokens" ADD CONSTRAINT "login_tokens_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "player_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "pin_hash" TEXT NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "player_devices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "player_devices_user_id_idx" ON "player_devices"("user_id");
ALTER TABLE "player_devices" ADD CONSTRAINT "player_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
