// Recovery of the 31 active crafting recipes from the old deployment's /crafting page
// (koeki-web.up.railway.app, export of 2026-09-14). Crafted outputs (kunai, armor pieces,
// tiered equipment...) don't exist in the recovered catalog yet, so this also creates them
// under a new "Équipement" category before wiring the recipes.
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "postgresql://koeki:koeki@127.0.0.1:5432/koeki?schema=public" }) });
const FLAG = "legacyCraftingImport2026-09-14";

type Line = [string, number];
interface RecipeDef { code: string; version: number; name: string; category: string; ingredients: Line[]; output?: string }

const RECIPES: RecipeDef[] = [
  { code: "REC-KUN-01", version: 1, name: "kunai", category: "Autre", ingredients: [["Cuivre", 1], ["Laine", 1]] },
  { code: "REC-KUN-02", version: 2, name: "kunai explosif", category: "Autre", ingredients: [["Plastique", 4], ["Cuivre", 4]] },
  { code: "REC-BAG-02", version: 2, name: "Bague T1", category: "T1", ingredients: [["Bois", 3], ["Cuivre", 3]] },
  { code: "REC-BAS-04", version: 1, name: "Bas Armure T1", category: "T1", ingredients: [["Bois", 5], ["Laine", 5]] },
  { code: "REC-BAS-03", version: 2, name: "Bas Jutsu T1", category: "T1", ingredients: [["Cuivre", 3], ["Plastique", 3]] },
  { code: "REC-BOT-02", version: 2, name: "Bottes T1", category: "T1", ingredients: [["Cuivre", 3], ["Plastique", 3]] },
  { code: "REC-COL-02", version: 2, name: "Collier T1", category: "T1", ingredients: [["Bois", 3], ["Laine", 3]] },
  { code: "REC-GAN-02", version: 1, name: "Gant T1", category: "T1", ingredients: [["Laine", 5], ["Plastique", 5]] },
  { code: "REC-HAU-04", version: 2, name: "Haut Armure T1", category: "T1", ingredients: [["Bois", 3], ["Cuivre", 3]] },
  { code: "REC-HAU-03", version: 1, name: "Haut Jutsu T1", category: "T1", ingredients: [["Laine", 5], ["Plastique", 5]] },
  { code: "REC-BAG-01", version: 2, name: "Bague T2", category: "T2", ingredients: [["Bois", 5], ["Cuivre", 5], ["Fer", 1]] },
  { code: "REC-BAS-01", version: 1, name: "Bas Armure T2", category: "T2", ingredients: [["Bois", 8], ["Laine", 8], ["Titane", 2]] },
  { code: "REC-BAS-02", version: 2, name: "Bas Jutsu T2", category: "T2", ingredients: [["Cuivre", 5], ["Plastique", 5], ["Fer", 1]] },
  { code: "REC-BOT-01", version: 2, name: "Bottes T2", category: "T2", ingredients: [["Plastique", 5], ["Cuivre", 5], ["Titane", 1]] },
  { code: "REC-COL-01", version: 2, name: "Collier T2", category: "T2", ingredients: [["Bois", 5], ["Laine", 5], ["Jade", 1]] },
  { code: "REC-GAN-01", version: 2, name: "Gant T2", category: "T2", ingredients: [["Laine", 5], ["Bois", 5], ["Titane", 1]] },
  { code: "REC-HAU-01", version: 1, name: "Haut Armure T2", category: "T2", ingredients: [["Bois", 8], ["Cuivre", 8], ["Fer", 2]] },
  { code: "REC-HAU-02", version: 2, name: "Haut Jutsu T2", category: "T2", ingredients: [["Laine", 5], ["Plastique", 5], ["Jade", 1]] },
  { code: "REC-BAG-03", version: 2, name: "Bague T3", category: "T3", ingredients: [["Plastique", 7], ["Laine", 7], ["Bois", 7], ["Fer", 3], ["Jade", 3], ["Chakra Metal", 1]] },
  { code: "REC-BAS-07", version: 1, name: "Bas Armure T3", category: "T3", ingredients: [["Plastique", 10], ["Laine", 10], ["Cuivre", 10], ["Jade", 4], ["Fer", 4], ["Chakra Metal", 1]] },
  { code: "REC-BAS-06", version: 1, name: "Bas Jutsu T3", category: "T3", ingredients: [["Plastique", 10], ["Cuivre", 10], ["Bois", 10], ["Jade", 4], ["Titane", 4], ["Chakra Metal", 1]] },
  { code: "REC-BAS-05", version: 1, name: "Bas vie T3", category: "T3", ingredients: [["Laine", 10], ["Cuivre", 10], ["Bois", 10], ["Fer", 4], ["Titane", 4], ["Chakra Metal", 1]] },
  { code: "REC-BOT-05", version: 1, name: "Bottes Armure T3", category: "T3", ingredients: [["Plastique", 10], ["Cuivre", 10], ["Bois", 10], ["Jade", 4], ["Titane", 4], ["Chakra Metal", 1]] },
  { code: "REC-BOT-04", version: 2, name: "Bottes Jutsu T3", category: "T3", ingredients: [["Plastique", 7], ["Laine", 7], ["Bois", 7], ["Jade", 3], ["Titane", 3], ["Chakra Metal", 1]] },
  { code: "REC-BOT-03", version: 1, name: "Bottes Ténacité T3", category: "T3", ingredients: [["Cuivre", 10], ["Laine", 10], ["Bois", 10], ["Fer", 4], ["Titane", 4], ["Chakra Metal", 1]] },
  { code: "REC-BOU-01", version: 1, name: "Boucle T3", category: "T3", ingredients: [["Plastique", 10], ["Laine", 10], ["Bois", 10], ["Jade", 4], ["Fer", 4], ["Chakra Metal", 1]] },
  { code: "REC-COL-03", version: 2, name: "Collier T3", category: "T3", ingredients: [["Cuivre", 7], ["Laine", 7], ["Bois", 7], ["Fer", 3], ["Titane", 3], ["Chakra Metal", 1]] },
  { code: "REC-GAN-03", version: 1, name: "Gant T3", category: "T3", ingredients: [["Plastique", 10], ["Cuivre", 10], ["Bois", 10], ["Jade", 4], ["Titane", 4], ["Chakra Metal", 1]] },
  { code: "REC-HAU-06", version: 2, name: "Haut Armure T3", category: "T3", ingredients: [["Plastique", 7], ["Cuivre", 7], ["Laine", 7], ["Fer", 3], ["Chakra Metal", 1], ["Jade", 3]] },
  { code: "REC-HAU-05", version: 1, name: "Haut Jutsu T3", category: "T3", ingredients: [["Plastique", 10], ["Laine", 10], ["Cuivre", 10], ["Fer", 4], ["Titane", 4], ["Chakra Metal", 1]] },
  { code: "REC-EQU-01", version: 1, name: "Equipement T4 (Même pour tous)", category: "T4", ingredients: [["Plastique", 14], ["Laine", 14], ["Cuivre", 14], ["Bois", 14], ["Titane", 6], ["Fer", 6], ["Jade", 6], ["Chakra Metal", 4]] }
];

async function main() {
  if (await prisma.appSetting.findUnique({ where: { key: FLAG } })) { console.log("import-crafting : déjà appliqué"); return; }
  const equipmentCategory = await prisma.resourceCategory.upsert({ where: { code: "EQUIPEMENT_CRAFT" }, create: { code: "EQUIPEMENT_CRAFT", label: "Équipement" }, update: {} });

  let recipesCreated = 0, resourcesCreated = 0;
  await prisma.$transaction(async (tx) => {
    const resourceByName = new Map((await tx.resource.findMany()).map((resource) => [resource.name.toLowerCase(), resource]));
    const usedCodes = new Set((await tx.resource.findMany({ select: { code: true } })).map((resource) => resource.code));
    const codeBase = (name: string) => name.normalize("NFD").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "X");
    async function resolveResource(name: string) {
      const existing = resourceByName.get(name.toLowerCase());
      if (existing) return existing;
      const base = codeBase(name);
      let code = "", suffix = 1;
      do { code = `RES-${base}-${String(suffix++).padStart(2, "0")}`; } while (usedCodes.has(code));
      usedCodes.add(code);
      const created = await tx.resource.create({ data: { code, name, categoryId: equipmentCategory.id, minimumStock: new Prisma.Decimal(0), criticalStock: new Prisma.Decimal(0), description: "Objet fabriqué en atelier — repris de l'ancien registre (migration Supabase, 14/09/2026)" } });
      resourceByName.set(name.toLowerCase(), created);
      resourcesCreated++;
      return created;
    }

    for (const def of RECIPES) {
      const existingRecipe = await tx.craftRecipe.findUnique({ where: { code_version: { code: def.code, version: def.version } } });
      if (existingRecipe) continue;
      const outputResource = await resolveResource(def.output ?? def.name);
      const ingredientResources = await Promise.all(def.ingredients.map(async ([name, qty]) => ({ resource: await resolveResource(name), qty })));
      const recipe = await tx.craftRecipe.create({ data: {
        code: def.code, version: def.version, name: def.name, category: def.category,
        description: "Repris de l'ancien registre (migration Supabase, 14/09/2026)",
        difficulty: "Standard", durationRpMinutes: 60, cost: 0n, isPublic: true, status: "ACTIVE"
      } });
      await tx.craftRecipeIngredient.createMany({ data: ingredientResources.map(({ resource, qty }) => ({ recipeId: recipe.id, resourceId: resource.id, quantity: new Prisma.Decimal(qty) })) });
      await tx.craftRecipeOutput.create({ data: { recipeId: recipe.id, resourceId: outputResource.id, quantity: new Prisma.Decimal(1) } });
      recipesCreated++;
    }
    await tx.appSetting.create({ data: { key: FLAG, value: { importedAt: new Date().toISOString(), recipesCreated, resourcesCreated } } });
  }, { timeout: 300_000, maxWait: 30_000 });
  console.log(`import-crafting : ${recipesCreated} recettes créées, ${resourcesCreated} ressources d'équipement créées`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
