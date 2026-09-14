-- Performance pass now that the app runs on real production-scale data (632+
-- ninjas, growing tax/transaction history): these columns are filtered/sorted
-- directly in several hot read paths (lib/data.ts) but had no supporting index,
-- meaning Postgres had to scan the full table for each of them.
CREATE INDEX "NinjaProfile_status_idx" ON "NinjaProfile"("status");
CREATE INDEX "TaxPayment_createdAt_idx" ON "TaxPayment"("createdAt");
CREATE INDEX "ResourceTransaction_type_status_createdAt_idx" ON "ResourceTransaction"("type", "status", "createdAt");
