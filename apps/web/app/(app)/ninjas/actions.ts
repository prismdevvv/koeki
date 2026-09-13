"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { Prisma, prisma } from "@koeki/database";
import { exemptionUse, planLegacySettlement } from "@koeki/domain";
import { getRpService, loadNinjaFiscal } from "@/lib/data";
import { awardPoints, grantExemption, isUniqueViolation, loadExemptionPolicy, nextPaymentReceipt, nextTransactionReceipt, refreshAssessmentStatus, scaledTimes, withReceiptRetry, writeAudit } from "@/lib/finance";
import { billCurrentWeekAfterGradeResolution } from "@/lib/grade-tax";
import { findOrCreateNinjaProfileForCharacter } from "@/lib/ninja-link";
import { demoMode, getSession, hasPermission, requireWriteAccess } from "@/lib/session";
import { findSunaCharacterByCharKey } from "@/lib/zenkai";

const createNinjaSchema = z.object({
  firstName: z.string().trim().min(1, "Le prénom est obligatoire").max(80),
  lastName: z.string().trim().min(1, "Le nom est obligatoire").max(80),
  gradeId: z.string().min(1, "Le grade est obligatoire"),
  alias: z.string().trim().max(80).optional().transform((value) => value || null),
  clan: z.string().trim().max(80).optional().transform((value) => value || null),
  notes: z.string().trim().max(2000).optional().transform((value) => value || null)
});

/** Allocates a never-reused public code from the PostgreSQL sequence. */
async function nextNinjaCode(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ nextValue: bigint }>>`
    SELECT nextval('"NinjaProfile_code_seq"') AS "nextValue"
  `;
  const nextValue = Number(rows[0]?.nextValue ?? 1n);
  if (!Number.isSafeInteger(nextValue) || nextValue < 1 || nextValue > 999_999) throw new Error("Le registre a épuisé les codes ninja disponibles");
  return `NIN-${String(nextValue).padStart(6, "0")}`;
}

async function lockNinjaRegistry(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(621714422)`;
}

async function assertNinjaNameAvailable(tx: Prisma.TransactionClient, firstName: string, lastName: string, excludeId?: string) {
  const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("fr-FR");
  const identity = `${normalize(firstName)}|${normalize(lastName)}`;
  const candidates = await tx.ninjaProfile.findMany({
    where: { status: { not: "ARCHIVED" }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { code: true, firstName: true, lastName: true }
  });
  const duplicate = candidates.find((candidate) => `${normalize(candidate.firstName)}|${normalize(candidate.lastName)}` === identity);
  if (duplicate) throw new Error(`VALIDATION:Une fiche « ${duplicate.firstName} ${duplicate.lastName} » (${duplicate.code}) existe déjà dans le registre`);
}

async function cancelTaxesAfterDeath(tx: Prisma.TransactionClient, ninjaId: string, diedAt: Date) {
  const future = await tx.taxAssessment.findMany({
    where: {
      ninjaId,
      dueAt: { gt: diedAt },
      status: { in: ["UPCOMING", "DUE", "OVERDUE", "PARTIALLY_PAID", "PAID"] }
    }
  });
  let cancelled = 0;
  let refunded = 0n;
  for (const assessment of future) {
    const debits = await tx.exemptionLedgerEntry.findMany({
      where: {
        ninjaId,
        amount: { lt: 0 },
        OR: [
          {
            sourceType: "TaxAssessment",
            OR: [{ sourceId: assessment.id }, { sourceId: { startsWith: `${assessment.id}:` } }]
          },
          { sourceType: "TaxSettlement", sourceId: { endsWith: `:${assessment.id}` } }
        ]
      },
      select: { amount: true }
    });
    const amount = -debits.reduce((total, entry) => total + entry.amount, 0n);
    if (amount > 0n) {
      const existingRefund = await tx.exemptionLedgerEntry.findUnique({ where: { sourceType_sourceId: { sourceType: "DeathCancellation", sourceId: assessment.id } } });
      if (!existingRefund) {
        await grantExemption(tx, {
          ninjaId,
          amount,
          sourceType: "DeathCancellation",
          sourceId: assessment.id,
          reason: "Restitution du crédit consommé après le décès"
        });
        refunded += amount;
      }
    }
    const result = await tx.taxAssessment.updateMany({
      where: { id: assessment.id, status: { in: ["UPCOMING", "DUE", "OVERDUE", "PARTIALLY_PAID", "PAID"] } },
      data: { status: "CANCELLED", version: { increment: 1 } }
    });
    cancelled += result.count;
  }
  return { cancelled, refunded };
}

export async function createNinja(formData: FormData) {
  const session = await requireWriteAccess("ninjas:write");
  const parsed = createNinjaSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`/ninjas/new?erreur=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Saisie invalide")}`);
  let ninjaId = "";
  try {
    ninjaId = await prisma.$transaction(async (tx) => {
      await lockNinjaRegistry(tx);
      await assertNinjaNameAvailable(tx, parsed.data.firstName, parsed.data.lastName);
      const grade = await tx.ninjaGrade.findFirst({ where: { id: parsed.data.gradeId, isActive: true, code: { not: "UNKNOWN" } } });
      if (!grade) throw new Error("VALIDATION:Grade inconnu ou inactif");
      const next = await nextNinjaCode(tx);
      const ninja = await tx.ninjaProfile.create({ data: { code: next, firstName: parsed.data.firstName, lastName: parsed.data.lastName, alias: parsed.data.alias, clan: parsed.data.clan, notes: parsed.data.notes, currentGradeId: grade.id } });
      await tx.ninjaGradeHistory.create({ data: { ninjaId: ninja.id, gradeId: grade.id, effectiveFrom: new Date(), reason: "Création du dossier", changedById: session.userId } });
      await writeAudit(tx, { actorId: session.userId, action: "NINJA_CREATED", entityType: "NinjaProfile", entityId: ninja.id, newValues: { code: next, firstName: parsed.data.firstName, lastName: parsed.data.lastName, grade: grade.code } });
      return ninja.id;
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) redirect(`/ninjas/new?erreur=${encodeURIComponent(error.message.slice("VALIDATION:".length))}`);
    if (isUniqueViolation(error)) redirect(`/ninjas/new?erreur=${encodeURIComponent("Ce dossier existe déjà — rechargez le registre")}`);
    throw error;
  }
  redirect(`/ninjas/${ninjaId}`);
}

/** Self-service: an invited agent registers their own ninja sheet, linked to their account. */
export async function createOwnProfile(formData: FormData) {
  if (demoMode) throw new Error("Mode démonstration : les écritures sont désactivées");
  const session = await getSession();
  if (!session) throw new Error("UNAUTHENTICATED");
  const existing = await prisma.ninjaProfile.findUnique({ where: { userId: session.userId } });
  if (existing) redirect(`/ninjas/${existing.id}`);
  if (formData.get("confirmNew") !== "on") redirect(`/profil?erreur=${encodeURIComponent("Confirmez d’abord que votre personnage n’existe pas dans le registre")}`);
  const parsed = createNinjaSchema.omit({ notes: true }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`/profil?erreur=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Saisie invalide")}`);
  let ninjaId = "";
  try {
    ninjaId = await prisma.$transaction(async (tx) => {
      await lockNinjaRegistry(tx);
      const linked = await tx.ninjaProfile.findUnique({ where: { userId: session.userId }, select: { id: true } });
      if (linked) throw new Error(`EXISTING:${linked.id}`);
      await assertNinjaNameAvailable(tx, parsed.data.firstName, parsed.data.lastName);
      const grade = await tx.ninjaGrade.findFirst({ where: { id: parsed.data.gradeId, isActive: true, code: { not: "UNKNOWN" } } });
      if (!grade) throw new Error("VALIDATION:Grade inconnu ou inactif");
      const code = await nextNinjaCode(tx);
      const ninja = await tx.ninjaProfile.create({ data: { code, firstName: parsed.data.firstName, lastName: parsed.data.lastName, alias: parsed.data.alias, clan: parsed.data.clan, currentGradeId: grade.id, userId: session.userId } });
      await tx.ninjaGradeHistory.create({ data: { ninjaId: ninja.id, gradeId: grade.id, effectiveFrom: new Date(), reason: "Auto-enregistrement à l’arrivée", changedById: session.userId } });
      await writeAudit(tx, { actorId: session.userId, action: "NINJA_SELF_REGISTERED", entityType: "NinjaProfile", entityId: ninja.id, newValues: { code, firstName: parsed.data.firstName, lastName: parsed.data.lastName, grade: grade.code } });
      return ninja.id;
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("EXISTING:")) redirect(`/ninjas/${error.message.slice("EXISTING:".length)}`);
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) redirect(`/profil?erreur=${encodeURIComponent(`${error.message.slice("VALIDATION:".length)} — réclamez la fiche existante au lieu d’en créer une nouvelle`)}`);
    if (isUniqueViolation(error)) redirect(`/profil?erreur=${encodeURIComponent("Cette fiche vient déjà d’être créée ou liée")}`);
    throw error;
  }
  redirect(`/ninjas/${ninjaId}`);
}

/** Links an existing unclaimed record to the signed-in account (imported registers have no linked users). */
export async function claimOwnProfile(formData: FormData) {
  if (demoMode) throw new Error("Mode démonstration : les écritures sont désactivées");
  const session = await getSession();
  if (!session) throw new Error("UNAUTHENTICATED");
  const existing = await prisma.ninjaProfile.findUnique({ where: { userId: session.userId } });
  if (existing) redirect(`/ninjas/${existing.id}`);
  const reference = formData.get("ninjaRef");
  if (typeof reference !== "string" || !reference.trim()) redirect("/profil?erreur=Tapez%20le%20nom%20de%20votre%20fiche");
  const code = /NIN-\d{6}/.exec(reference)?.[0];
  const name = reference.split("·")[0]?.trim() ?? reference.trim();
  const target = code
    ? await prisma.ninjaProfile.findUnique({ where: { code } })
    : await prisma.ninjaProfile.findFirst({ where: { status: "ACTIVE", userId: null, AND: name.split(/\s+/).map((part) => ({ OR: [{ firstName: { equals: part, mode: "insensitive" } }, { lastName: { contains: part, mode: "insensitive" } }] })) } });
  if (!target) redirect(`/profil?erreur=${encodeURIComponent("Fiche introuvable — choisissez une proposition de la liste")}`);
  let claimed = false;
  try {
    claimed = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "NinjaProfile" WHERE id = ${target!.id} FOR UPDATE`;
      const alreadyLinked = await tx.ninjaProfile.findUnique({ where: { userId: session.userId }, select: { id: true } });
      if (alreadyLinked) throw new Error(`EXISTING:${alreadyLinked.id}`);
      await tx.invitation.updateMany({
        where: { ninjaProfileId: target!.id, status: "PENDING", expiresAt: { lte: new Date() } },
        data: { status: "EXPIRED" }
      });
      const reservation = await tx.invitation.findFirst({ where: { ninjaProfileId: target!.id, status: "PENDING" }, select: { id: true } });
      if (reservation) throw new Error("VALIDATION:Cette fiche est réservée par une invitation en cours");
      const updated = await tx.ninjaProfile.updateMany({ where: { id: target!.id, userId: null, status: "ACTIVE" }, data: { userId: session.userId, version: { increment: 1 } } });
      if (updated.count === 1) await writeAudit(tx, { actorId: session.userId, action: "NINJA_CLAIMED", entityType: "NinjaProfile", entityId: target!.id, reason: "Fiche existante liée au compte lors de l’arrivée" });
      return updated.count === 1;
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("EXISTING:")) redirect(`/ninjas/${error.message.slice("EXISTING:".length)}`);
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) redirect(`/profil?erreur=${encodeURIComponent(error.message.slice("VALIDATION:".length))}`);
    if (isUniqueViolation(error)) redirect(`/profil?erreur=${encodeURIComponent("Cette fiche ou votre compte vient déjà d’être lié")}`);
    throw error;
  }
  if (!claimed) redirect("/profil?erreur=Cette%20fiche%20n%E2%80%99est%20plus%20disponible");
  redirect(`/ninjas/${target!.id}`);
}

const updateNinjaSchema = createNinjaSchema.extend({
  ninjaId: z.string().min(1),
  status: z.enum(["ACTIVE", "INACTIVE", "DECEASED"]).default("ACTIVE"),
  diedAt: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]).optional()
}).omit({ gradeId: true });

export async function updateNinja(formData: FormData) {
  if (demoMode) throw new Error("Mode démonstration : les écritures sont désactivées");
  const session = await getSession();
  if (!session) throw new Error("UNAUTHENTICATED");
  const parsed = updateNinjaSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`/ninjas?erreur=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Saisie invalide")}`);
  const { ninjaId, diedAt: diedAtInput, ...data } = parsed.data!;
  const back = (message: string): never => redirect(`/ninjas/${ninjaId}/modifier?erreur=${encodeURIComponent(message)}`);
  if (data.status === "DECEASED" && !diedAtInput) back("La date du décès est obligatoire");
  const diedAt = data.status === "DECEASED" ? new Date(`${diedAtInput}T12:00:00.000Z`) : null;
  if (diedAt) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (Number.isNaN(diedAt.getTime()) || diedAt.toISOString().slice(0, 10) !== diedAtInput || diedAtInput! > today) back("Date de décès invalide ou située dans le futur");
  }
  const canWrite = hasPermission(session, "ninjas:write");
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "NinjaProfile" WHERE id = ${ninjaId} FOR UPDATE`;
      const previous = await tx.ninjaProfile.findUnique({ where: { id: ninjaId } });
      if (!previous) throw new Error("VALIDATION:Dossier introuvable");
      if (previous.status === "ARCHIVED") throw new Error("VALIDATION:Ce dossier est archivé — restaurez-le explicitement avant de le modifier");
      if (previous.status === "DECEASED") {
        const previousDeathDate = previous.diedAt?.toISOString().slice(0, 10);
        if (data.status !== "DECEASED" || !diedAt || diedAtInput !== previousDeathDate) {
          throw new Error("VALIDATION:Un décès enregistré ne peut pas être annulé ou antidaté depuis ce formulaire");
        }
      }
      const isOwner = previous.userId === session.userId;
      if (!canWrite && !isOwner) throw new Error("FORBIDDEN");
      if (canWrite) {
        await lockNinjaRegistry(tx);
        await assertNinjaNameAvailable(tx, data.firstName, data.lastName, ninjaId);
        await tx.ninjaProfile.update({ where: { id: ninjaId }, data: { ...data, diedAt, version: { increment: 1 } } });
        if (data.status !== "ACTIVE") {
          await tx.invitation.updateMany({ where: { ninjaProfileId: ninjaId, status: "PENDING" }, data: { status: "REVOKED", revokedAt: new Date() } });
        }
        const deathEffects = diedAt ? await cancelTaxesAfterDeath(tx, ninjaId, diedAt) : { cancelled: 0, refunded: 0n };
        await writeAudit(tx, { actorId: session.userId, action: "NINJA_UPDATED", entityType: "NinjaProfile", entityId: ninjaId,
          previousValues: { firstName: previous.firstName, lastName: previous.lastName, alias: previous.alias, clan: previous.clan, status: previous.status, diedAt: previous.diedAt },
          newValues: { firstName: data.firstName, lastName: data.lastName, alias: data.alias, clan: data.clan, status: data.status, diedAt, cancelledFutureTaxes: deathEffects.cancelled, refundedExemption: Number(deathEffects.refunded) } });
      } else {
        // Owners may only adjust their pseudonym and clan — identity and status stay manager-controlled.
        await tx.ninjaProfile.update({ where: { id: ninjaId }, data: { alias: data.alias, clan: data.clan, version: { increment: 1 } } });
        await writeAudit(tx, { actorId: session.userId, action: "NINJA_SELF_UPDATED", entityType: "NinjaProfile", entityId: ninjaId,
          previousValues: { alias: previous.alias, clan: previous.clan }, newValues: { alias: data.alias, clan: data.clan } });
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) back(error.message.slice("VALIDATION:".length));
    if (isUniqueViolation(error)) back("Une autre fiche porte déjà cette identité");
    throw error;
  }
  redirect(`/ninjas/${ninjaId}`);
}

export async function restoreNinja(formData: FormData) {
  const session = await requireWriteAccess("ninjas:write");
  const ninjaId = formData.get("ninjaId");
  if (typeof ninjaId !== "string" || !ninjaId) redirect("/ninjas");
  const back = (message: string): never => redirect(`/ninjas/${ninjaId}/modifier?erreur=${encodeURIComponent(message)}`);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "NinjaProfile" WHERE id = ${ninjaId as string} FOR UPDATE`;
      const archived = await tx.ninjaProfile.findFirst({
        where: { id: ninjaId as string, status: "ARCHIVED" },
        select: { firstName: true, lastName: true, diedAt: true, archivedFromStatus: true }
      });
      if (!archived) throw new Error("VALIDATION:Ce dossier n’est plus archivé");
      await lockNinjaRegistry(tx);
      await assertNinjaNameAvailable(tx, archived.firstName, archived.lastName, ninjaId as string);
      const storedStatus = archived.archivedFromStatus;
      const status = storedStatus === "ACTIVE" || storedStatus === "INACTIVE" || storedStatus === "DECEASED"
        ? storedStatus
        : archived.diedAt ? "DECEASED" : "INACTIVE";
      const restored = await tx.ninjaProfile.updateMany({
        where: { id: ninjaId as string, status: "ARCHIVED" },
        data: { status, archivedFromStatus: null, version: { increment: 1 } }
      });
      if (restored.count !== 1) throw new Error("VALIDATION:Ce dossier n’est plus archivé");
      await writeAudit(tx, { actorId: session.userId, action: "NINJA_RESTORED", entityType: "NinjaProfile", entityId: ninjaId as string, newValues: { status } });
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) back(error.message.slice("VALIDATION:".length));
    throw error;
  }
  redirect(`/ninjas/${ninjaId}`);
}

/** Hard-deletes only spotless records; anything with financial history is archived instead. */
export async function deleteNinja(formData: FormData) {
  const session = await requireWriteAccess("ninjas:write");
  const ninjaId = formData.get("ninjaId");
  if (typeof ninjaId !== "string" || !ninjaId || formData.get("confirm") !== "on") redirect(`/ninjas/${ninjaId}/modifier?erreur=Cochez%20la%20confirmation`);
  const back = (message: string): never => redirect(`/ninjas/${ninjaId}/modifier?erreur=${encodeURIComponent(message)}`);
  let result: { code: string; outcome: "supprime" | "archive" } | null = null;
  try {
    result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "NinjaProfile" WHERE id = ${ninjaId as string} FOR UPDATE`;
      const ninja = await tx.ninjaProfile.findUnique({
        where: { id: ninjaId as string },
        include: {
          equipment: { select: { id: true } },
          _count: { select: { assessments: true, payments: true, pointEntries: true, resourceTransactions: true, invitations: true, exemptionEntries: true, eventsWon: true } }
        }
      });
      if (!ninja) return null;
      if (ninja.status === "ARCHIVED") throw new Error("VALIDATION:Ce dossier est déjà archivé");
      const counts = ninja._count;
      const hasHistory = Boolean(ninja.userId || ninja.equipment)
        || counts.assessments + counts.payments + counts.pointEntries + counts.resourceTransactions + counts.invitations + counts.exemptionEntries + counts.eventsWon > 0;
      if (hasHistory) {
        const archivedFromStatus = ninja.status === "ACTIVE" || ninja.status === "DECEASED" ? ninja.status : "INACTIVE";
        await tx.invitation.updateMany({ where: { ninjaProfileId: ninja.id, status: "PENDING" }, data: { status: "REVOKED", revokedAt: new Date() } });
        await tx.ninjaProfile.update({
          where: { id: ninja.id },
          data: { status: "ARCHIVED", archivedFromStatus, userId: null, version: { increment: 1 } }
        });
        await writeAudit(tx, {
          actorId: session.userId,
          action: "NINJA_ARCHIVED",
          entityType: "NinjaProfile",
          entityId: ninja.id,
          reason: "Historique ou relation existante : archivage au lieu d’une suppression",
          previousValues: { status: ninja.status },
          newValues: { status: "ARCHIVED", archivedFromStatus }
        });
        return { code: ninja.code, outcome: "archive" as const };
      }
      await tx.ninjaGradeHistory.deleteMany({ where: { ninjaId: ninja.id } });
      await tx.ninjaProfile.delete({ where: { id: ninja.id } });
      await writeAudit(tx, { actorId: session.userId, action: "NINJA_DELETED", entityType: "NinjaProfile", entityId: ninja.id, newValues: { code: ninja.code } });
      return { code: ninja.code, outcome: "supprime" as const };
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) back(error.message.slice("VALIDATION:".length));
    throw error;
  }
  if (!result) redirect("/ninjas?erreur=Dossier%20introuvable");
  redirect(`/ninjas?info=${encodeURIComponent(`Dossier ${result.code} ${result.outcome === "supprime" ? "supprimé définitivement" : "archivé (historique financier conservé)"}`)}`);
}

const paymentSchema = z.object({
  ninjaId: z.string().min(1),
  amount: z.coerce.number().int().min(0, "Montant invalide").max(100_000_000).default(0),
  reference: z.string().trim().max(120).optional().transform((value) => value || null),
  idempotencyKey: z.string().uuid()
});


/** Core settlement flow: the agent ticks the weeks, then records what the player gave —
 *  Ryō and/or donated items. Item coverage is computed from each resource's per-unit
 *  exemption rate in the database. Donated value applies first (as exemptions), Ryō
 *  complete the rest; ticked old-register weeks (no amount) share the surplus through
 *  matching exceptional-debt entries. Any unused donated value stays as credit. */
export async function recordPayment(formData: FormData) {
  const session = await requireWriteAccess("payments:write");
  const parsed = paymentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`/ninjas?erreur=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Saisie invalide")}`);
  const { ninjaId, amount, reference, idempotencyKey } = parsed.data;
  const back = (message: string) => redirect(`/ninjas/${ninjaId}?erreur=${encodeURIComponent(message)}`);
  const selected = formData.getAll("years").map(String).filter(Boolean);
  if (!selected.length) back("Cochez au moins une semaine à régler");
  if (new Set(selected).size !== selected.length) back("Une même semaine ne peut être réglée qu’une seule fois");
  const items: Array<{ resourceId: string; quantity: number }> = [];
  for (let index = 1; index <= 500; index++) {
    const resourceId = formData.get(`resourceId_${index}`);
    const quantityRaw = formData.get(`quantity_${index}`);
    if (resourceId === null && quantityRaw === null) break;
    if (typeof resourceId === "string" && resourceId && typeof quantityRaw === "string" && quantityRaw && quantityRaw !== "0") {
      const quantity = Number(quantityRaw);
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1_000_000) back(`Quantité invalide sur l’objet ${index} — nombre entier requis`);
      if (items.some((item) => item.resourceId === resourceId)) back("Un même objet apparaît deux fois");
      items.push({ resourceId, quantity });
    }
  }
  if (amount === 0 && !items.length) back("Indiquez des Ryō reçus et/ou des objets donnés");
  const service = await getRpService();
  let receipt = "";
  try {
    receipt = await withReceiptRetry(() => prisma.$transaction(async (tx) => {
      // Serialize concurrent settlements on the same record, then recompute on locked state.
      await tx.$executeRaw`SELECT id FROM "NinjaProfile" WHERE id = ${ninjaId} FOR UPDATE`;
      const profile = await tx.ninjaProfile.findUnique({ where: { id: ninjaId }, select: { status: true } });
      if (!profile) throw new Error("VALIDATION:Ninja introuvable");
      if (profile.status !== "ACTIVE") throw new Error("VALIDATION:Ce dossier ninja n’est pas actif");
      const assessments = await loadNinjaFiscal(ninjaId, tx);
      if (!assessments) throw new Error("VALIDATION:Ninja introuvable");
      const targets = selected.map((id) => assessments.find((assessment) => assessment.id === id)).filter((target): target is NonNullable<typeof target> => Boolean(target)).sort((a, b) => a.rpYear - b.rpYear);
      if (targets.length !== selected.length) throw new Error("VALIDATION:Semaine introuvable pour ce dossier");
      if (targets.some((target) => ["EXEMPT", "WAIVED", "SUSPENDED", "CANCELLED"].includes(target.status))) throw new Error("VALIDATION:Une semaine cochée est déjà exonérée ou remise");
      if (targets.some((target) => target.remaining === 0n && target.status !== "OVERDUE")) throw new Error("VALIDATION:Une semaine cochée est déjà soldée");
      const exemptionPolicy = await loadExemptionPolicy(tx);

      // Donated items become a validated donation (stock, points, credit) whose value covers the weeks.
      let donationValue = 0n;
      let donationReceipt: string | null = null;
      if (items.length) {
        const lines: Array<{ resourceId: string; quantity: number; exemptionPerUnit: bigint; unitPrice: bigint; pointsPerUnit: number }> = [];
        for (const item of items) {
          const resource = await tx.resource.findUnique({ where: { id: item.resourceId } });
          if (!resource || !resource.isActive) throw new Error("VALIDATION:Objet inconnu ou inactif");
          lines.push({ resourceId: item.resourceId, quantity: item.quantity, exemptionPerUnit: resource.exemptionPerUnit, unitPrice: resource.exemptionPerUnit, pointsPerUnit: resource.pointsPerUnit });
          donationValue += scaledTimes(item.quantity, resource.exemptionPerUnit);
        }
        donationReceipt = await nextTransactionReceipt(tx, "DONATION");
        const transaction = await tx.resourceTransaction.create({ data: {
          receiptNumber: donationReceipt, type: "DONATION", status: "VALIDATED", ninjaId, agentId: session.userId,
          totalAmount: donationValue, idempotencyKey: `${idempotencyKey}:don`, validatedAt: new Date()
        } });
        await tx.resourceTransactionItem.createMany({ data: lines.map((line) => ({ transactionId: transaction.id, resourceId: line.resourceId, quantity: new Prisma.Decimal(line.quantity), unitPriceSnapshot: line.unitPrice, lineTotal: scaledTimes(line.quantity, line.exemptionPerUnit) })) });
        for (const line of lines) await tx.inventoryMovement.create({ data: { resourceId: line.resourceId, type: "DONATION_IN", quantity: new Prisma.Decimal(line.quantity), unitCost: line.unitPrice, transactionId: transaction.id, agentId: session.userId, justification: `Reçu ${donationReceipt}`, idempotencyKey: `${idempotencyKey}:don:${line.resourceId}` } });
        const donationPoints = await awardPoints(tx, { ninjaId, eventType: "DONATION", amount: donationValue, sourceType: "ResourceTransaction", sourceId: transaction.id, basePoints: lines.reduce((total, line) => total + line.quantity * line.pointsPerUnit, 0) });
        if (donationPoints > 0) await tx.resourceTransaction.update({ where: { id: transaction.id }, data: { totalPoints: donationPoints } });
        await grantExemption(tx, { ninjaId, amount: donationValue, sourceType: "ResourceTransaction", sourceId: transaction.id, reason: `Don ${donationReceipt}` });
      }

      const debtTargets = targets.filter((target) => target.remaining > 0n);
      const legacyTargets = targets.filter((target) => target.remaining === 0n);
      const potRyo = BigInt(amount);
      let donLeft = donationValue, ryoLeft = potRyo;
      let legacyDebtAdded = 0n;
      const exemptionUses: Array<{ assessmentId: string; rpYear: number; amount: bigint }> = [];
      const allocations: Array<{ assessmentId: string; amount: bigint }> = [];
      for (const target of debtTargets) {
        let need = target.remaining;
        const gross = target.original + target.penalties + target.adjustments;
        const fromDon = exemptionUse({ availableCredit: donLeft, remainingDebt: need, gross, alreadyExempted: target.exemptions, coverageBps: exemptionPolicy.weeklyTaxCoverageBps });
        if (fromDon > 0n) { exemptionUses.push({ assessmentId: target.id, rpYear: target.rpYear, amount: fromDon }); donLeft -= fromDon; need -= fromDon; }
        const fromRyo = ryoLeft < need ? ryoLeft : need;
        if (fromRyo > 0n) { allocations.push({ assessmentId: target.id, amount: fromRyo }); ryoLeft -= fromRyo; need -= fromRyo; }
      }
      if (legacyTargets.length) {
        const rate = exemptionPolicy.weeklyTaxCoverageBps;
        const plan = planLegacySettlement({ weeks: legacyTargets.length, ryo: ryoLeft, availableCredit: donLeft, coverageBps: rate });
        if (!plan) {
          if (rate < 10_000 && ryoLeft < BigInt(legacyTargets.length)) throw new Error(`VALIDATION:Les ${legacyTargets.length} semaines de l’ancien registre nécessitent au moins ${legacyTargets.length} Ryō au total avec le plafond actuel`);
          throw new Error("VALIDATION:Le montant disponible ne permet pas d’affecter chaque semaine cochée");
        }
        for (const [index, target] of legacyTargets.entries()) {
          const { ryo: fromRyo, credit: fromDon, debt: exceptionalDebt } = plan.lines[index]!;
          await tx.taxAdjustment.create({ data: { assessmentId: target.id, type: "EXCEPTIONAL_DEBT", amount: exceptionalDebt, reason: `Régularisation ancien registre — semaine RP ${target.rpYear}`, createdById: session.userId } });
          legacyDebtAdded += exceptionalDebt;
          if (fromDon > 0n) { exemptionUses.push({ assessmentId: target.id, rpYear: target.rpYear, amount: fromDon }); donLeft -= fromDon; }
          if (fromRyo > 0n) { allocations.push({ assessmentId: target.id, amount: fromRyo }); ryoLeft -= fromRyo; }
        }
      }
      if (ryoLeft > 0n) throw new Error("VALIDATION:Il reste des Ryō non affectés — réduisez le montant ou cochez d’autres semaines (le surplus d’objets, lui, reste en crédit)");
      const touched = new Set([...allocations.map((entry) => entry.assessmentId), ...exemptionUses.map((entry) => entry.assessmentId)]);
      const untouched = targets.filter((target) => !touched.has(target.id));
      if (untouched.length) throw new Error(`VALIDATION:Aucun montant n’est affecté à ${untouched.length > 1 ? "certaines semaines cochées" : `la semaine RP ${untouched[0]!.rpYear}`} — décochez-les ou ajoutez des Ryō`);

      let paymentReceipt: string | null = null;
      if (potRyo > 0n) {
        paymentReceipt = await nextPaymentReceipt(tx);
        const balanceBefore = assessments.reduce((total, assessment) => total + assessment.remaining, 0n) + legacyDebtAdded;
        const coveredByDonation = exemptionUses.reduce((total, entry) => total + entry.amount, 0n);
        const settled = potRyo + coveredByDonation;
        const payment = await tx.taxPayment.create({ data: {
          receiptNumber: paymentReceipt, ninjaId, recordedById: session.userId, amount: potRyo, method: "RYO", reference, status: "VALIDATED",
          balanceBefore, balanceAfter: balanceBefore > settled ? balanceBefore - settled : 0n, idempotencyKey, validatedAt: new Date()
        } });
        if (allocations.length) await tx.taxPaymentAllocation.createMany({ data: allocations.map((entry, index) => ({ paymentId: payment.id, assessmentId: entry.assessmentId, amount: entry.amount, allocationOrder: index + 1 })) });
        await awardPoints(tx, { ninjaId, eventType: legacyTargets.length ? "REGULARIZATION" : "TAX_PAYMENT", amount: potRyo, sourceType: "TaxPayment", sourceId: payment.id });
      }
      for (const use of exemptionUses) {
        await tx.taxExemption.create({ data: { assessmentId: use.assessmentId, amount: use.amount, reason: `Couvert par don${donationReceipt ? ` (${donationReceipt})` : ""}`, grantedById: session.userId } });
        await grantExemption(tx, { ninjaId, amount: -use.amount, sourceType: "TaxSettlement", sourceId: `${idempotencyKey}:${use.assessmentId}`, reason: `Semaine RP ${use.rpYear} couverte par don` });
      }
      for (const target of targets) await refreshAssessmentStatus(tx, target.id, service.currentRpYear());
      const mainReceipt = paymentReceipt ?? donationReceipt ?? "";
      await writeAudit(tx, { actorId: session.userId, action: "PAYMENT_RECORDED", entityType: paymentReceipt ? "TaxPayment" : "ResourceTransaction", entityId: mainReceipt, reason: `Règlement semaines RP ${targets.map((target) => target.rpYear).join(", ")} — ${Number(potRyo).toLocaleString("fr-FR")} Ryō${donationValue > 0n ? ` + ${Number(donationValue).toLocaleString("fr-FR")} ¥ d’objets donnés` : ""}${reference ? ` (${reference})` : ""}`, newValues: { ryo: Number(potRyo), donationValue: Number(donationValue), weeks: targets.map((target) => target.rpYear), receipts: [paymentReceipt, donationReceipt].filter(Boolean) } });
      return mainReceipt;
    }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) back(error.message.slice("VALIDATION:".length));
    if (isUniqueViolation(error)) back("Ce règlement a déjà été enregistré (double soumission détectée)");
    throw error;
  }
  redirect(`/ninjas/${ninjaId}?recu=${encodeURIComponent(receipt)}`);
}

const waiveSchema = z.object({
  ninjaId: z.string().min(1),
  assessmentId: z.string().min(1, "Choisissez une année"),
  reason: z.string().trim().min(3, "Un motif est obligatoire").max(300)
});

/** Waives a tax year entirely (statut Remise) — the player owes nothing for it. */
export async function waiveAssessment(formData: FormData) {
  const session = await requireWriteAccess("taxes:write");
  const parsed = waiveSchema.safeParse(Object.fromEntries(formData));
  const ninjaIdRaw = typeof formData.get("ninjaId") === "string" ? String(formData.get("ninjaId")) : "";
  const back = (message: string): never => redirect(`/ninjas/${ninjaIdRaw}?erreur=${encodeURIComponent(message)}`);
  if (!parsed.success) back(parsed.error.issues[0]?.message ?? "Saisie invalide");
  const { ninjaId, assessmentId, reason } = parsed.data!;
  let outcome = "";
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const assessments = await loadNinjaFiscal(ninjaId, tx);
      const target = assessments?.find((assessment) => assessment.id === assessmentId);
      if (!target) throw new Error("VALIDATION:Année fiscale introuvable pour ce dossier");
      if (["EXEMPT", "WAIVED", "CANCELLED"].includes(target.status)) throw new Error("VALIDATION:Cette année est déjà exonérée ou remise");
      await tx.taxAssessment.update({ where: { id: assessmentId }, data: { status: "WAIVED", version: { increment: 1 } } });
      await writeAudit(tx, { actorId: session.userId, action: "TAX_WAIVED", entityType: "TaxAssessment", entityId: assessmentId, reason, previousValues: { status: target.status, remaining: Number(target.remaining) } });
      return `Année RP ${target.rpYear} remise (annulée) — motif consigné`;
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) back(error.message.slice("VALIDATION:".length));
    throw error;
  }
  redirect(`/ninjas/${ninjaId}?info=${encodeURIComponent(outcome)}`);
}

const gradeChangeSchema = z.object({ ninjaId: z.string().min(1), gradeId: z.string().min(1), reason: z.string().trim().min(3, "Un motif est obligatoire").max(300) });

export async function changeGrade(formData: FormData) {
  const session = await requireWriteAccess("ninjas:write");
  const parsed = gradeChangeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`/ninjas?erreur=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Saisie invalide")}`);
  const { ninjaId, gradeId, reason } = parsed.data;
  const back = (message: string): never => redirect(`/ninjas/${ninjaId}?erreur=${encodeURIComponent(message)}`);
  const service = await getRpService();
  let outcome = "Grade mis à jour";
  try {
    await prisma.$transaction(async (tx) => {
      // Same order as weekly/admin billing: global fiscal lock first, ninja row second.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(621714423)`;
      await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "NinjaProfile" WHERE "id" = ${ninjaId} FOR UPDATE`;
      const [ninja, grade] = await Promise.all([
        tx.ninjaProfile.findUnique({ where: { id: ninjaId }, include: { currentGrade: true } }),
        tx.ninjaGrade.findFirst({ where: { id: gradeId, isActive: true, code: { not: "UNKNOWN" } } })
      ]);
      if (!ninja || !grade) throw new Error("VALIDATION:Dossier ou grade introuvable");
      if (ninja.status !== "ACTIVE") throw new Error("VALIDATION:Le grade d’un dossier inactif, décédé ou archivé ne peut pas être modifié");
      if (ninja.currentGradeId === gradeId) {
        outcome = "Grade inchangé — aucune modification";
        return;
      }
      const billing = ninja.currentGrade.code === "UNKNOWN"
        ? await billCurrentWeekAfterGradeResolution(tx, service, { ninjaId, grade, actorId: session.userId })
        : null;
      const changedAt = new Date();
      await tx.ninjaGradeHistory.updateMany({ where: { ninjaId, effectiveTo: null }, data: { effectiveTo: changedAt } });
      await tx.ninjaGradeHistory.create({ data: { ninjaId, gradeId, effectiveFrom: changedAt, reason, changedById: session.userId } });
      await tx.ninjaProfile.update({ where: { id: ninjaId }, data: { currentGradeId: gradeId, version: { increment: 1 } } });
      await writeAudit(tx, {
        actorId: session.userId,
        action: "GRADE_CHANGED",
        entityType: "NinjaProfile",
        entityId: ninjaId,
        reason,
        previousValues: { grade: ninja.currentGrade.code },
        newValues: billing
          ? { grade: grade.code, currentTaxRpYear: billing.rpYear, currentTaxAmount: Number(billing.amount), exemptionCreditUsed: Number(billing.covered) }
          : { grade: grade.code }
      });
      if (billing?.billed) {
        outcome = billing.amount > 0n
          ? `Grade mis à jour — semaine RP ${billing.rpYear} facturée ${Number(billing.amount).toLocaleString("fr-FR")} Ryō${billing.covered > 0n ? `, ${Number(billing.covered).toLocaleString("fr-FR")} Ryō de crédit appliqués` : ""}`
          : `Grade mis à jour — semaine RP ${billing.rpYear} enregistrée comme non imposable`;
      }
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) back(error.message.slice("VALIDATION:".length));
    if (isUniqueViolation(error)) back("Un autre changement de grade vient d’être enregistré — rechargez la fiche");
    throw error;
  }
  redirect(`/ninjas/${ninjaId}?info=${encodeURIComponent(outcome)}`);
}

/** Opens the fiche for a Zenkai character reached straight from the registry
 * search — creating it on the spot (grade mapped from the Zenkai rank) if none
 * exists yet, so agents never have to go through a separate "create a fiche"
 * step before acting on someone. */
export async function openZenkaiCharacter(formData: FormData) {
  const session = await requireWriteAccess("ninjas:write");
  const charKey = formData.get("charKey");
  if (typeof charKey !== "string" || !charKey) redirect("/ninjas");
  const character = await findSunaCharacterByCharKey(charKey);
  if (!character) redirect(`/ninjas?erreur=${encodeURIComponent("Personnage introuvable sur Zenkai — rafraîchissez la recherche")}`);
  try {
    const ninjaId = await findOrCreateNinjaProfileForCharacter(session.userId, character!);
    redirect(`/ninjas/${ninjaId}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) redirect(`/ninjas?erreur=${encodeURIComponent(error.message.slice("VALIDATION:".length))}`);
    throw error;
  }
}

const adjustPointsSchema = z.object({
  ninjaId: z.string().min(1),
  points: z.coerce.number().int("Nombre entier requis").refine((value) => value !== 0, "Indiquez un nombre de points non nul").min(-100_000).max(100_000),
  reason: z.string().trim().min(3, "Un motif est obligatoire").max(300)
});

/** Manual point award/deduction outside the normal payment/donation flows —
 * for one-off recognitions, corrections, or sanctions. Always audited. */
export async function adjustPoints(formData: FormData) {
  const session = await requireWriteAccess("ninjas:write");
  const parsed = adjustPointsSchema.safeParse(Object.fromEntries(formData));
  const rawNinjaId = typeof formData.get("ninjaId") === "string" ? String(formData.get("ninjaId")) : "";
  const back = (message: string): never => redirect(`/ninjas/${rawNinjaId}?erreur=${encodeURIComponent(message)}`);
  if (!parsed.success) back(parsed.error.issues[0]?.message ?? "Saisie invalide");
  const { ninjaId, points, reason } = parsed.data!;
  try {
    await prisma.$transaction(async (tx) => {
      const ninja = await tx.ninjaProfile.findUnique({ where: { id: ninjaId }, select: { status: true } });
      if (!ninja || ninja.status !== "ACTIVE") throw new Error("VALIDATION:Dossier introuvable ou inactif");
      await awardPoints(tx, { ninjaId, eventType: "MANUAL_ADJUSTMENT", amount: BigInt(points), sourceType: "ManualAdjustment", sourceId: crypto.randomUUID(), basePoints: points, reason });
      await writeAudit(tx, { actorId: session.userId, action: "POINTS_ADJUSTED", entityType: "NinjaProfile", entityId: ninjaId, reason, newValues: { points } });
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) back(error.message.slice("VALIDATION:".length));
    throw error;
  }
  redirect(`/ninjas/${ninjaId}?info=${encodeURIComponent(`${points > 0 ? "+" : ""}${points} point${Math.abs(points) > 1 ? "s" : ""} — motif consigné`)}`);
}
