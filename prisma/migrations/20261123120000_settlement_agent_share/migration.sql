-- Profit and loss are shared between an Admin and its Agent: the Agent's slice
-- is `users.agent_share` tenths (1 = a 9:1 Admin:Agent split). Each settlement
-- freezes the slice that applied when it was first written, so a later change
-- to an Agent's share cannot rewrite what was already settled.
--
-- Existing rows get 0: before this, the Admin carried the whole position, and
-- history stays exactly as it was.
ALTER TABLE "settlements" ADD COLUMN "agent_share" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_agent_share_range" CHECK ("agent_share" BETWEEN 0 AND 10);
