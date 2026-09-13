// Full recovery of the ninja registry from the old deployment (koeki-web.up.railway.app),
// export of 2026-09-13 — 629 fiches with real grade, points and lifecycle status, parsed
// programmatically from the rendered /ninjas page (see data/legacy-ninjas-raw.txt +
// parse-legacy-ninjas.mjs) rather than transcribed by hand. Debt itself was already
// recovered by import-recouvrement-2026-09-13.ts for the 289 active overdue fiches; this
// pass only fills in what that one couldn't know: real grade, ranking points, and whether
// a ninja is deceased/inactive. Idempotent — safe to re-run.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "postgresql://koeki:koeki@127.0.0.1:5432/koeki?schema=public" }) });
const FLAG = "legacyNinjasFullImport2026-09-13";

interface Record { code: string; firstName: string; lastName: string; gradeCode: string; status: "ACTIVE" | "DECEASED" | "INACTIVE"; situation: string; debt: number; points: number; yearsLate: number }

async function main() {
  if (await prisma.appSetting.findUnique({ where: { key: FLAG } })) { console.log("import-ninjas-full : déjà appliqué"); return; }
  const records: Record[] = JSON.parse(readFileSync(join(__dirname, "..", "data", "legacy-ninjas.json"), "utf8"));
  const [grades, systemUser] = await Promise.all([
    prisma.ninjaGrade.findMany(),
    prisma.user.findFirst({ where: { roles: { some: { role: { code: "SUPER_ADMIN" } } } }, orderBy: { createdAt: "asc" } })
  ]);
  if (!systemUser) { console.log("import-ninjas-full : référentiels absents — exécutez d'abord le bootstrap"); return; }
  const gradeByCode = new Map(grades.map((grade) => [grade.code, grade]));

  let created = 0, updated = 0, pointsSet = 0;
  await prisma.$transaction(async (tx) => {
    for (const record of records) {
      const grade = gradeByCode.get(record.gradeCode) ?? gradeByCode.get("UNKNOWN")!;
      // DECEASED requires a death date we don't have from the old list — land as INACTIVE
      // with a note instead of fabricating a date, a human confirms and flips it properly.
      const dbStatus = record.status === "DECEASED" ? "INACTIVE" : record.status;
      const note = record.status === "DECEASED"
        ? "Marqué décédé sur l'ancien registre (migration Supabase, 13/09/2026) — date de décès inconnue, passé en Inactif en attendant confirmation."
        : "Reprise de l'ancien registre (migration Supabase, 13/09/2026)";
      const existing = await tx.ninjaProfile.findUnique({ where: { code: record.code } });
      if (existing) {
        if (existing.currentGradeId !== grade.id || existing.status !== dbStatus) {
          const now = new Date();
          await tx.ninjaProfile.update({ where: { id: existing.id }, data: { currentGradeId: grade.id, status: dbStatus } });
          await tx.ninjaGradeHistory.updateMany({ where: { ninjaId: existing.id, effectiveTo: null }, data: { effectiveTo: now } });
          await tx.ninjaGradeHistory.create({ data: { ninjaId: existing.id, gradeId: grade.id, effectiveFrom: now, reason: "Reprise du grade réel de l'ancien registre (migration Supabase, 13/09/2026)", changedById: systemUser.id } });
          updated++;
        }
      } else {
        const profile = await tx.ninjaProfile.create({ data: {
          code: record.code, firstName: record.firstName, lastName: record.lastName, currentGradeId: grade.id, status: dbStatus,
          notes: note
        } });
        await tx.ninjaGradeHistory.create({ data: { ninjaId: profile.id, gradeId: grade.id, effectiveFrom: new Date(), reason: "Import de l'ancien registre", changedById: systemUser.id } });
        created++;
        await applyPoints(tx, profile.id, record);
        continue;
      }
      await applyPoints(tx, existing.id, record);
    }
    await tx.appSetting.create({ data: { key: FLAG, value: { importedAt: new Date().toISOString(), created, updated, total: records.length } } });
    await tx.auditLog.create({ data: { action: "LEGACY_NINJAS_FULL_IMPORT", entityType: "NinjaProfile", entityId: FLAG, requestId: randomUUID(), reason: `Reprise complète du registre de l'ancien site : ${created} fiches créées, ${updated} mises à jour (grade/statut), sur ${records.length} au total` } });

    async function applyPoints(txc: typeof tx, ninjaId: string, record: Record) {
      if (record.points === 0) return;
      const sourceId = `legacy2026-09-13:${record.code}`;
      const already = await txc.pointLedgerEntry.findUnique({ where: { sourceType_sourceId_eventType: { sourceType: "Import", sourceId, eventType: "MANUAL_ADJUSTMENT" } } });
      if (already) return;
      await txc.pointLedgerEntry.create({ data: { ninjaId, eventType: "MANUAL_ADJUSTMENT", points: record.points, sourceType: "Import", sourceId, reason: "Reprise du solde de points de l'ancien registre (migration Supabase, 13/09/2026)" } });
      pointsSet++;
    }
  }, { timeout: 300_000, maxWait: 30_000 });
  console.log(`import-ninjas-full : ${created} fiches créées, ${updated} mises à jour, ${pointsSet} soldes de points repris (sur ${records.length})`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
