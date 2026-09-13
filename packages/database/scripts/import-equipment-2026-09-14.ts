// Recovery of the Jōnin equipment board from the old deployment (koeki-web.up.railway.app,
// export of 2026-09-14, transcribed from the rendered /equipement page — 18 fiches).
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "postgresql://koeki:koeki@127.0.0.1:5432/koeki?schema=public" }) });
const FLAG = "legacyEquipmentImport2026-09-14";

type Slot = { tier: string; type: string | null };
type Loadout = { haut: Slot; bas: Slot; bottes: Slot; boucles: Slot; bague: Slot; collier: Slot; gants: Slot };
const s = (tier: string, type: string | null): Slot => ({ tier, type });

const EQUIPMENT: Record<string, Loadout> = {
  "NIN-001384": { haut: s("T2", "Jutsu"), bas: s("T3", "Jutsu"), bottes: s("T3", "Armure"), boucles: s("Aucun", null), bague: s("T2", ""), collier: s("T3", ""), gants: s("Aucun", null) },
  "NIN-001329": { haut: s("T4", "Jutsu"), bas: s("T4", "Armure"), bottes: s("T4", "Armure"), boucles: s("T4", ""), bague: s("T4", ""), collier: s("T4", ""), gants: s("T4", "") },
  "NIN-000867": { haut: s("T4", "Jutsu"), bas: s("T4", "Armure"), bottes: s("T4", "Jutsu"), boucles: s("T4", ""), bague: s("T4", ""), collier: s("T4", ""), gants: s("T3", "") },
  "NIN-001067": { haut: s("T4", "Jutsu"), bas: s("T4", "Armure"), bottes: s("T4", "Armure"), boucles: s("T3", ""), bague: s("T4", ""), collier: s("T4", ""), gants: s("T2", "") },
  "NIN-000893": { haut: s("T3", "Armure"), bas: s("T3", "Jutsu"), bottes: s("T2", "Jutsu"), boucles: s("T3", ""), bague: s("T2", ""), collier: s("Aucun", null), gants: s("T3", "") },
  "NIN-001108": { haut: s("T2", ""), bas: s("T3", "Armure"), bottes: s("T3", "Ténacité"), boucles: s("Aucun", null), bague: s("Aucun", null), collier: s("Aucun", null), gants: s("Aucun", null) },
  "NIN-000998": { haut: s("T3", "Armure"), bas: s("T2", "Jutsu"), bottes: s("T3", "Jutsu"), boucles: s("Aucun", null), bague: s("T2", ""), collier: s("T2", ""), gants: s("Aucun", null) },
  "NIN-001417": { haut: s("Aucun", null), bas: s("Aucun", null), bottes: s("Aucun", null), boucles: s("Aucun", null), bague: s("Aucun", null), collier: s("Aucun", null), gants: s("Aucun", null) },
  "NIN-001394": { haut: s("T3", "Jutsu"), bas: s("T3", "Armure"), bottes: s("T4", "Ténacité"), boucles: s("T3", ""), bague: s("T3", ""), collier: s("T3", ""), gants: s("T3", "") },
  "NIN-001479": { haut: s("T3", "Jutsu"), bas: s("T3", "Armure"), bottes: s("T3", "Jutsu"), boucles: s("Aucun", null), bague: s("T3", ""), collier: s("T3", ""), gants: s("Aucun", null) },
  "NIN-001401": { haut: s("T3", "Jutsu"), bas: s("T3", "Jutsu"), bottes: s("T3", "Ténacité"), boucles: s("Aucun", null), bague: s("T3", ""), collier: s("T3", ""), gants: s("Aucun", null) },
  "NIN-001110": { haut: s("Aucun", null), bas: s("Aucun", null), bottes: s("Aucun", null), boucles: s("Aucun", null), bague: s("Aucun", null), collier: s("Aucun", null), gants: s("Aucun", null) },
  "NIN-000823": { haut: s("T3", "Armure"), bas: s("T4", "Armure"), bottes: s("T2", "Armure"), boucles: s("Aucun", null), bague: s("T3", ""), collier: s("T3", ""), gants: s("T4", "") },
  "NIN-001457": { haut: s("T3", "Jutsu"), bas: s("Aucun", null), bottes: s("Aucun", null), boucles: s("Aucun", null), bague: s("T3", ""), collier: s("T2", ""), gants: s("Aucun", null) },
  "NIN-000976": { haut: s("T3", "Armure"), bas: s("T3", "Jutsu"), bottes: s("T3", "Jutsu"), boucles: s("T3", ""), bague: s("T1", ""), collier: s("T1", ""), gants: s("T2", "") },
  "NIN-001048": { haut: s("T3", "Armure"), bas: s("T3", "Jutsu"), bottes: s("T3", "Armure"), boucles: s("Aucun", null), bague: s("Aucun", null), collier: s("T2", ""), gants: s("T2", "") },
  "NIN-001190": { haut: s("T3", "Armure"), bas: s("T3", "Armure"), bottes: s("T4", "Armure"), boucles: s("T3", ""), bague: s("T2", ""), collier: s("T3", ""), gants: s("T2", "") },
  "NIN-001426": { haut: s("T3", "Jutsu"), bas: s("T3", "Armure"), bottes: s("T3", "Armure"), boucles: s("T3", ""), bague: s("T3", ""), collier: s("Aucun", null), gants: s("T3", "") }
};

async function main() {
  if (await prisma.appSetting.findUnique({ where: { key: FLAG } })) { console.log("import-equipment : déjà appliqué"); return; }
  const systemUser = await prisma.user.findFirst({ where: { roles: { some: { role: { code: "SUPER_ADMIN" } } } }, orderBy: { createdAt: "asc" } });
  if (!systemUser) { console.log("import-equipment : référentiels absents"); return; }
  let applied = 0, missing = 0;
  for (const [code, slots] of Object.entries(EQUIPMENT)) {
    const ninja = await prisma.ninjaProfile.findUnique({ where: { code } });
    if (!ninja) { console.log(`ignoré (fiche introuvable) : ${code}`); missing++; continue; }
    await prisma.ninjaEquipment.upsert({ where: { ninjaId: ninja.id }, create: { ninjaId: ninja.id, slots, updatedById: systemUser.id }, update: { slots, updatedById: systemUser.id } });
    applied++;
  }
  await prisma.appSetting.create({ data: { key: FLAG, value: { importedAt: new Date().toISOString(), applied, missing } } });
  console.log(`import-equipment : ${applied} panoplies appliquées, ${missing} fiches introuvables`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
