-- One WhatsApp number per purpose per Agent (support, tokens, ...), replacing
-- the single users.whatsapp_number. The old column is left in place, unread.

CREATE TABLE "agent_contacts" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "whatsapp_number" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_contacts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_contacts_agent_id_purpose_key" ON "agent_contacts"("agent_id", "purpose");
ALTER TABLE "agent_contacts" ADD CONSTRAINT "agent_contacts_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing numbers become the Agent's "support" number. md5() gives a unique
-- text id without needing an extension (pgcrypto / gen_random_uuid).
INSERT INTO "agent_contacts" ("id", "agent_id", "purpose", "whatsapp_number", "updated_at")
SELECT md5(random()::text || "id"), "id", 'support', "whatsapp_number", CURRENT_TIMESTAMP
FROM "users"
WHERE "whatsapp_number" IS NOT NULL;
