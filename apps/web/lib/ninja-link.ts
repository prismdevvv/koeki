import { Prisma, prisma } from "@koeki/database";
import type { ZenkaiCharacter } from "./zenkai";

// Miroir du mapping de rangs Zenkai (`apps/web/lib/zenkai.ts`) vers les codes de grade Kōeki
// définis au bootstrap (`packages/database/prisma/bootstrap.ts`).
const RANK_TO_GRADE_CODE: Record<string, string> = {
  apprentis_genin: "GENIN_APPRENTICE",
  genin: "GENIN",
  "genin confirme": "GENIN_CONFIRMED",
  chunin: "CHUNIN",
  "chunin confirme": "KONIN",
  "tk-jonin": "TOKUBETSU_JONIN",
  jonin: "JONIN",
  cmd: "JONIN_COMMANDER",
  kage: "KAGE"
};

async function nextNinjaCode(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ nextValue: bigint }>>`SELECT nextval('"NinjaProfile_code_seq"') AS "nextValue"`;
  const nextValue = Number(rows[0]?.nextValue ?? 1n);
  return `NIN-${String(nextValue).padStart(6, "0")}`;
}

function splitZenkaiName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0] ?? name.trim(), lastName: parts.slice(1).join(" ") || parts[0] || name.trim() };
}

const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("fr-FR");

/**
 * Miroir de la liaison automatique de hopital-suna (resolveShinobiForCharacter) : à chaque
 * connexion Discord, on rattache le compte à la fiche ninja existante correspondant au nom du
 * personnage Zenkai (en la réclamant si elle est encore libre), ou on en crée une nouvelle si
 * aucune fiche ne correspond. Idempotent — ne fait rien si le compte a déjà une fiche liée.
 */
export async function linkOrCreateNinjaForZenkaiCharacter(userId: string, character: ZenkaiCharacter): Promise<void> {
  const alreadyLinked = await prisma.ninjaProfile.findUnique({ where: { userId }, select: { id: true } });
  if (alreadyLinked) return;

  const { firstName, lastName } = splitZenkaiName(character.name);
  const identity = `${normalize(firstName)}|${normalize(lastName)}`;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(621714422)`;
    const stillUnlinked = await tx.ninjaProfile.findUnique({ where: { userId }, select: { id: true } });
    if (stillUnlinked) return;

    const candidates = await tx.ninjaProfile.findMany({ where: { status: "ACTIVE" }, select: { id: true, firstName: true, lastName: true, userId: true } });
    const match = candidates.find((candidate) => `${normalize(candidate.firstName)}|${normalize(candidate.lastName)}` === identity);

    if (match) {
      if (match.userId) return; // Déjà réclamée par un autre compte — pas de conflit à créer ici.
      await tx.ninjaProfile.update({ where: { id: match.id }, data: { userId, version: { increment: 1 } } });
      await tx.auditLog.create({ data: { actorId: userId, action: "NINJA_CLAIMED", entityType: "NinjaProfile", entityId: match.id, reason: "Fiche existante liée au compte via le personnage Zenkai", requestId: crypto.randomUUID() } });
      return;
    }

    const gradeCode = RANK_TO_GRADE_CODE[character.rank] ?? "UNKNOWN";
    const grade = await tx.ninjaGrade.findUnique({ where: { code: gradeCode } });
    if (!grade) return;
    const code = await nextNinjaCode(tx);
    const ninja = await tx.ninjaProfile.create({ data: { code, firstName, lastName, currentGradeId: grade.id, userId } });
    await tx.ninjaGradeHistory.create({ data: { ninjaId: ninja.id, gradeId: grade.id, effectiveFrom: new Date(), reason: "Auto-enregistrement via Zenkai à l’arrivée", changedById: userId } });
    await tx.auditLog.create({ data: { actorId: userId, action: "NINJA_SELF_REGISTERED", entityType: "NinjaProfile", entityId: ninja.id, newValues: { code, firstName, lastName, grade: grade.code }, requestId: crypto.randomUUID() } });
  }).catch((error) => {
    console.warn(`[ninja-link] liaison auto impossible pour ${userId} : ${error instanceof Error ? error.message : String(error)}`);
  });
}

/**
 * Resolves a Zenkai character straight to a NinjaProfile id for recording a
 * transaction, without requiring anyone to have created a fiche first: reuses
 * an existing ACTIVE fiche matched by name, or creates a minimal one on the
 * spot (no linked Discord account — that can happen later at sign-in via
 * `linkOrCreateNinjaForZenkaiCharacter`, which will simply claim this fiche).
 */
export async function findOrCreateNinjaProfileForCharacter(actorId: string, character: ZenkaiCharacter): Promise<string> {
  const { firstName, lastName } = splitZenkaiName(character.name);
  const identity = `${normalize(firstName)}|${normalize(lastName)}`;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(621714422)`;
    const candidates = await tx.ninjaProfile.findMany({ where: { status: "ACTIVE" }, select: { id: true, firstName: true, lastName: true } });
    const match = candidates.find((candidate) => `${normalize(candidate.firstName)}|${normalize(candidate.lastName)}` === identity);
    if (match) return match.id;

    const gradeCode = RANK_TO_GRADE_CODE[character.rank] ?? "UNKNOWN";
    const grade = await tx.ninjaGrade.findUnique({ where: { code: gradeCode } });
    if (!grade) throw new Error("VALIDATION:Grade Zenkai inconnu pour ce personnage — contactez un administrateur");
    const code = await nextNinjaCode(tx);
    const ninja = await tx.ninjaProfile.create({ data: { code, firstName, lastName, currentGradeId: grade.id } });
    await tx.ninjaGradeHistory.create({ data: { ninjaId: ninja.id, gradeId: grade.id, effectiveFrom: new Date(), reason: "Auto-enregistrement via Zenkai (transaction)", changedById: actorId } });
    await tx.auditLog.create({ data: { actorId, action: "NINJA_AUTO_REGISTERED", entityType: "NinjaProfile", entityId: ninja.id, newValues: { code, firstName, lastName, grade: grade.code }, requestId: crypto.randomUUID() } });
    return ninja.id;
  });
}
