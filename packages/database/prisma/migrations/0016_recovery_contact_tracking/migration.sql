-- Tracks the last time an economic agent reached out to a ninja about an
-- overdue tax debt, so the Recovery queue can show "already contacted"
-- instead of agents duplicating the same relance blind.
ALTER TABLE "NinjaProfile"
  ADD COLUMN "lastContactedAt" TIMESTAMP(3),
  ADD COLUMN "lastContactedById" TEXT;

ALTER TABLE "NinjaProfile"
  ADD CONSTRAINT "NinjaProfile_lastContactedById_fkey"
  FOREIGN KEY ("lastContactedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "NinjaProfile_lastContactedAt_idx" ON "NinjaProfile"("lastContactedAt");
