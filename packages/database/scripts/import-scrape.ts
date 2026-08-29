// One-shot import of the production snapshot scraped from koeki-web.up.railway.app
// (2026-08-29/30, no direct DB access available). Populates resources, ninjas, an opening
// debt balance, the last 100 donations, crafting recipes, equipment and events. Never part
// of the production startup — run manually against a target DATABASE_URL.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "postgresql://koeki:koeki@127.0.0.1:5432/koeki?schema=public" }) });
const DATA_DIR = process.env.IMPORT_DATA_DIR ?? join(__dirname, "..", "data", "import-scrape");
const load = <T>(file: string): T => JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as T;

interface ResourceRow { code: string; name: string; category: string; price: number | null; pointsPerUnit: number; exemptionPerUnit: number; stock: number; demand: string; active: boolean }
interface NinjaRow { code: string; firstName: string; lastName: string; alias: string | null; gradeCode: string; status: string; debt: number; points: number }
interface DonRow { date: string; ninjaCode: string | null; ninjaName: string; items: Array<{ quantity: number; resourceName: string }>; points: number; exemption: number; validated: boolean; receipt: string }
interface CraftRow { code: string; name: string; category: string; durationMinutes: number; cost: number; version: number; ingredients: Array<{ quantity: number; resourceName: string }>; outputName: string }
interface EquipRow { ninjaCode: string; ninjaName: string; slots: Record<string, { tier: string; type: string | null }> }

async function main() {
  const FLAG = "scrapeImport2026-08-30";
  if (await prisma.appSetting.findUnique({ where: { key: FLAG } })) { console.log("import-scrape : déjà appliqué"); return; }

  const [categories, systemUser, grades] = await Promise.all([
    prisma.resourceCategory.findMany(),
    prisma.user.findFirst({ where: { roles: { some: { role: { code: "SUPER_ADMIN" } } } }, orderBy: { createdAt: "asc" } }),
    prisma.ninjaGrade.findMany()
  ]);
  if (!systemUser || !categories.length || !grades.length) { console.log("import-scrape : référentiels absents — exécutez d’abord le bootstrap"); return; }
  const categoryByCode = new Map(categories.map((c) => [c.code, c.id]));
  const gradeByCode = new Map(grades.map((g) => [g.code, g] as const));

  // ---------- Resources ----------
  const resourceRows = load<ResourceRow[]>("resources.json");
  const resourceByName = new Map<string, { id: string; code: string }>();
  for (const r of resourceRows) {
    const existing = await prisma.resource.findFirst({ where: { name: r.name } });
    const categoryId = categoryByCode.get(r.category) ?? categoryByCode.get("OTHER")!;
    const resource = existing
      ? await prisma.resource.update({ where: { id: existing.id }, data: { categoryId, demand: r.demand, isActive: r.active, pointsPerUnit: r.pointsPerUnit, exemptionPerUnit: BigInt(r.exemptionPerUnit) } })
      : await prisma.resource.create({ data: { code: r.code, name: r.name, categoryId, minimumStock: new Prisma.Decimal(0), criticalStock: new Prisma.Decimal(0), demand: r.demand, isActive: r.active, pointsPerUnit: r.pointsPerUnit, exemptionPerUnit: BigInt(r.exemptionPerUnit) } });
    if (r.price !== null) {
      await prisma.resourcePriceHistory.upsert({
        where: { resourceId_effectiveFrom: { resourceId: resource.id, effectiveFrom: new Date("2026-08-29T00:00:00Z") } },
        create: { resourceId: resource.id, pricePerUnit: BigInt(r.price), effectiveFrom: new Date("2026-08-29T00:00:00Z"), createdById: systemUser.id },
        update: { pricePerUnit: BigInt(r.price) }
      });
    }
    if (r.stock > 0) {
      const key = `imp-stock-${r.code}`;
      const movementExists = await prisma.inventoryMovement.findUnique({ where: { idempotencyKey: key } });
      if (!movementExists) await prisma.inventoryMovement.create({ data: { resourceId: resource.id, type: "MANUAL_ADJUSTMENT", quantity: new Prisma.Decimal(r.stock), agentId: systemUser.id, justification: "Reprise du stock (import snapshot 30/08/2026)", idempotencyKey: key } });
    }
    resourceByName.set(r.name, { id: resource.id, code: resource.code });
  }
  console.log(`resources : ${resourceRows.length} traitées`);

  function ensureResourceStub(name: string): string {
    const found = resourceByName.get(name);
    if (found) return found.id;
    throw new Error(`resource stub missing for ${name}`);
  }
  async function getOrCreateResource(name: string): Promise<string> {
    const found = resourceByName.get(name);
    if (found) return found.id;
    const base = name.normalize("NFD").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "X");
    const code = `RES-${base}-${Math.floor(Math.random() * 90 + 10)}`;
    const resource = await prisma.resource.create({ data: { code, name, categoryId: categoryByCode.get("OTHER")!, minimumStock: new Prisma.Decimal(0), criticalStock: new Prisma.Decimal(0) } });
    resourceByName.set(name, { id: resource.id, code: resource.code });
    return resource.id;
  }

  // ---------- Ninjas ----------
  const ninjaRows = load<NinjaRow[]>("ninjas.json");
  const ninjaByCode = new Map<string, string>();
  let created = 0;
  for (const n of ninjaRows) {
    const grade = gradeByCode.get(n.gradeCode) ?? gradeByCode.get("UNKNOWN")!;
    // Date de décès exacte inconnue du snapshot — placeholder requis par la contrainte de cohérence du cycle de vie.
    const diedAt = n.status === "DECEASED" ? new Date("2026-08-01T00:00:00Z") : null;
    const existing = await prisma.ninjaProfile.findUnique({ where: { code: n.code } });
    const ninja = existing
      ? await prisma.ninjaProfile.update({ where: { id: existing.id }, data: { firstName: n.firstName, lastName: n.lastName, alias: n.alias, status: n.status, diedAt, currentGradeId: grade.id } })
      : await prisma.ninjaProfile.create({ data: { code: n.code, firstName: n.firstName, lastName: n.lastName, alias: n.alias, status: n.status, diedAt, currentGradeId: grade.id, notes: "Import du snapshot koeki-web (30/08/2026) — historique fiscal détaillé non reconstituable sans accès direct à la base de production." } });
    if (!existing) {
      await prisma.ninjaGradeHistory.create({ data: { ninjaId: ninja.id, gradeId: grade.id, effectiveFrom: new Date("2026-08-29T00:00:00Z"), reason: "Import du snapshot koeki-web" } });
      if (n.points !== 0) await prisma.pointLedgerEntry.create({ data: { ninjaId: ninja.id, eventType: "MANUAL_ADJUSTMENT", points: n.points, sourceType: "Import", sourceId: `${FLAG}:${n.code}`, reason: "Reprise du solde de points du snapshot koeki-web" } });
      created++;
    }
    ninjaByCode.set(n.code, ninja.id);
  }
  console.log(`ninjas : ${ninjaRows.length} traités (${created} créés)`);

  // ---------- Opening debt balance ----------
  const reprisePolicy = await prisma.taxPolicy.upsert({ where: { name_version: { name: "Reprise snapshot", version: 1 } }, create: { name: "Reprise snapshot", version: 1, effectiveFromRpYear: 0, isActive: false }, update: {} });
  const repriseYear = await prisma.taxYear.upsert({ where: { rpYear: -1 }, create: { rpYear: -1, taxPolicyId: reprisePolicy.id, startsAt: new Date("2026-08-01T00:00:00Z"), endsAt: new Date("2026-08-29T23:59:59Z"), dueAt: new Date("2026-08-29T22:00:00Z") }, update: {} });
  let debtRows = 0;
  for (const n of ninjaRows) {
    if (n.debt <= 0) continue;
    const ninjaId = ninjaByCode.get(n.code)!;
    const grade = gradeByCode.get(n.gradeCode) ?? gradeByCode.get("UNKNOWN")!;
    await prisma.taxAssessment.upsert({
      where: { ninjaId_taxYearId: { ninjaId, taxYearId: repriseYear.id } },
      create: { ninjaId, taxYearId: repriseYear.id, taxPolicyId: reprisePolicy.id, gradeCodeSnapshot: grade.code, gradeLabelSnapshot: grade.label, originalAmount: BigInt(n.debt), dueAt: repriseYear.dueAt, status: "OVERDUE" },
      update: {}
    });
    debtRows++;
  }
  console.log(`dette d’ouverture : ${debtRows} fiches`);

  // ---------- Crafting ----------
  const craftRows = load<CraftRow[]>("crafting.json");
  for (const c of craftRows) {
    const existing = await prisma.craftRecipe.findUnique({ where: { code_version: { code: c.code, version: c.version } } });
    const recipe = existing ?? await prisma.craftRecipe.create({ data: { code: c.code, version: c.version, name: c.name, category: c.category, description: `${c.name} (import snapshot)`, difficulty: "NORMAL", durationRpMinutes: c.durationMinutes, cost: BigInt(c.cost), isPublic: true, status: "ACTIVE" } });
    if (existing) continue;
    for (const ing of c.ingredients) {
      const resourceId = await getOrCreateResource(ing.resourceName);
      await prisma.craftRecipeIngredient.upsert({ where: { recipeId_resourceId: { recipeId: recipe.id, resourceId } }, create: { recipeId: recipe.id, resourceId, quantity: new Prisma.Decimal(ing.quantity) }, update: {} });
    }
    const outputResourceId = await getOrCreateResource(c.outputName);
    await prisma.craftRecipeOutput.upsert({ where: { recipeId_resourceId: { recipeId: recipe.id, resourceId: outputResourceId } }, create: { recipeId: recipe.id, resourceId: outputResourceId, quantity: new Prisma.Decimal(1) }, update: {} });
  }
  console.log(`recettes : ${craftRows.length} traitées`);

  // ---------- Equipment ----------
  const equipRows = load<EquipRow[]>("equipment.json");
  let equipCreated = 0;
  for (const e of equipRows) {
    const ninjaId = ninjaByCode.get(e.ninjaCode);
    if (!ninjaId) continue;
    const existing = await prisma.ninjaEquipment.findUnique({ where: { ninjaId } });
    if (existing) continue;
    await prisma.ninjaEquipment.create({ data: { ninjaId, slots: e.slots as Prisma.InputJsonValue, updatedById: systemUser.id } });
    equipCreated++;
  }
  console.log(`équipement : ${equipCreated} panoplies créées`);

  // ---------- Dons ----------
  const donRows = load<DonRow[]>("dons.json");
  let donsCreated = 0;
  for (const d of donRows) {
    const ninjaId = d.ninjaCode ? ninjaByCode.get(d.ninjaCode) : undefined;
    if (!ninjaId || !d.items.length) continue;
    const existing = await prisma.resourceTransaction.findUnique({ where: { receiptNumber: d.receipt } });
    if (existing) continue;
    const items = [];
    for (const item of d.items) {
      const resourceId = resourceByName.get(item.resourceName)?.id ?? (await getOrCreateResource(item.resourceName));
      items.push({ resourceId, quantity: item.quantity });
    }
    const totalAmount = BigInt(d.exemption); // Approximation : valeur estimée = crédit d'exonération accordé.
    const transaction = await prisma.resourceTransaction.create({
      data: {
        receiptNumber: d.receipt, type: "DONATION", status: d.validated ? "VALIDATED" : "PENDING_APPROVAL",
        ninjaId, agentId: systemUser.id, totalAmount, totalPoints: d.points,
        idempotencyKey: `imp-${d.receipt}`, validatedAt: d.validated ? new Date(d.date) : null, createdAt: new Date(d.date)
      }
    });
    for (const item of items) {
      await prisma.resourceTransactionItem.create({ data: { transactionId: transaction.id, resourceId: item.resourceId, quantity: new Prisma.Decimal(item.quantity), unitPriceSnapshot: 0n, lineTotal: 0n } });
    }
    donsCreated++;
  }
  console.log(`dons : ${donsCreated}/${donRows.length} importés`);

  // ---------- Events ----------
  const tournaments = [
    { name: "Tournoi récolte #1", startsAt: "2026-07-04T15:27:59Z", endsAt: "2026-07-13T22:12:10Z", resourceFocus: "Toutes (hors Ryō)", winner: ["Kagemoto", "Shuni"], participants: 116 },
    { name: "Tournoi Lavande", startsAt: "2026-07-20T16:16:51Z", endsAt: "2026-07-29T10:22:29Z", resourceFocus: "Lavande", winner: ["Doma", "Nua"], participants: 15 }
  ];
  let eventsCreated = 0;
  for (const t of tournaments) {
    const exists = await prisma.event.findFirst({ where: { name: t.name } });
    if (exists) continue;
    const winner = await prisma.ninjaProfile.findFirst({ where: { firstName: t.winner[0], lastName: t.winner[1] } });
    await prisma.event.create({ data: { name: t.name, kind: "TOURNOI", status: "FINISHED", resourceFocus: t.resourceFocus, startsAt: new Date(t.startsAt), endsAt: new Date(t.endsAt), participantCount: t.participants, winnerId: winner?.id ?? null, description: "Importé depuis le snapshot koeki-web (30/08/2026)", createdAt: new Date(t.startsAt) } });
    eventsCreated++;
  }
  console.log(`événements : ${eventsCreated} créés`);

  await prisma.appSetting.create({ data: { key: FLAG, value: { importedAt: new Date().toISOString(), ninjas: ninjaRows.length, resources: resourceRows.length, dons: donsCreated, equipment: equipCreated, recipes: craftRows.length } } });
  await prisma.auditLog.create({ data: { action: "LEGACY_IMPORT", entityType: "NinjaProfile", entityId: FLAG, requestId: crypto.randomUUID(), reason: `Import du snapshot koeki-web du 30/08/2026 : ${ninjaRows.length} ninjas, ${resourceRows.length} ressources, ${donsCreated} dons, ${craftRows.length} recettes, ${equipCreated} panoplies — dette d’ouverture reprise pour ${debtRows} fiches, historique fiscal détaillé non reconstituable sans accès direct à la base de production.` } });
  console.log("import-scrape : terminé");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
