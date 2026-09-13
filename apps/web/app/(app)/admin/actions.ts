"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@koeki/database";
import { EXEMPTION_POLICY_SETTING_KEY } from "@koeki/domain";
import { getRpService } from "@/lib/data";
import { autoCoverOpenTaxes, writeAudit } from "@/lib/finance";
import { hasPermission, requireWriteAccess } from "@/lib/session";

/** Replaces a user's role set. Super-admins can grant everything; managers can grant
 *  everything except SUPER_ADMIN and cannot touch a super-admin's account. Roles are read
 *  from the database on every request, so the change applies immediately. */
export async function updateUserRoles(formData: FormData) {
  const session = await requireWriteAccess("settings:manage");
  const isSuper = hasPermission(session, "users:manage");
  const back = (message: string): never => redirect(`/admin?erreur=${encodeURIComponent(message)}`);
  const userId = formData.get("userId");
  if (typeof userId !== "string" || !userId) back("Utilisateur manquant");
  const [roles, target] = await Promise.all([
    prisma.role.findMany(),
    prisma.user.findUnique({ where: { id: userId as string }, include: { roles: { include: { role: true } }, ninjaProfile: { select: { firstName: true, lastName: true } } } })
  ]);
  if (!target) back("Utilisateur introuvable");
  const displayName = target!.ninjaProfile ? `${target!.ninjaProfile.firstName} ${target!.ninjaProfile.lastName}`.trim() : target!.name ?? target!.email ?? target!.id;
  const requested = roles.filter((role) => formData.get(`role_${role.code}`) === "on");
  const currentCodes = target!.roles.map((entry) => entry.role.code);
  if (!isSuper && currentCodes.includes("SUPER_ADMIN")) back("Seul un super-administrateur peut modifier les rôles d’un super-administrateur");
  if (!isSuper && requested.some((role) => role.code === "SUPER_ADMIN")) back("Seul un super-administrateur peut attribuer le rôle super-administrateur");
  if (!requested.length) back("Attribuez au moins un rôle — pour couper l’accès, utilisez la révocation");
  if (currentCodes.includes("SUPER_ADMIN") && !requested.some((role) => role.code === "SUPER_ADMIN")) {
    const otherSupers = await prisma.userRole.count({ where: { role: { code: "SUPER_ADMIN" }, userId: { not: target!.id }, user: { revokedAt: null } } });
    if (otherSupers === 0) back("Impossible de retirer le rôle du dernier super-administrateur actif");
  }
  const requestedIds = new Set(requested.map((role) => role.id));
  const currentIds = new Set(target!.roles.map((entry) => entry.roleId));
  const toAdd = requested.filter((role) => !currentIds.has(role.id));
  const toRemove = target!.roles.filter((entry) => !requestedIds.has(entry.roleId));
  if (!toAdd.length && !toRemove.length) redirect(`/admin?info=${encodeURIComponent("Rôles inchangés — rien à faire")}`);
  await prisma.$transaction(async (tx) => {
    if (toRemove.length) await tx.userRole.deleteMany({ where: { userId: target!.id, roleId: { in: toRemove.map((entry) => entry.roleId) } } });
    if (toAdd.length) await tx.userRole.createMany({ data: toAdd.map((role) => ({ userId: target!.id, roleId: role.id, assignedById: session.userId })) });
    await writeAudit(tx, { actorId: session.userId, action: "USER_ROLES_UPDATED", entityType: "User", entityId: target!.id, reason: `Rôles de ${displayName}`,
      previousValues: { roles: currentCodes }, newValues: { roles: requested.map((role) => role.code) } });
  });
  redirect(`/admin?info=${encodeURIComponent(`Rôles de ${displayName} mis à jour — effet immédiat`)}`);
}

const penaltySchema = z.object({
  // Saisi en pourcentage (ex. 10 ou 12,5), stocké en points de base pour un calcul entier exact.
  percent: z.union([z.literal(""), z.string().trim().transform((value) => Number(value.replace(",", "."))).pipe(z.number().min(0.01, "Taux invalide").max(100, "Taux maximum : 100 %"))]).transform((value) => (value === "" ? null : Math.round((value as number) * 100))),
  basis: z.enum(["ORIGINAL_TAX", "REMAINING_PRINCIPAL", "CURRENT_DEBT"]),
  maxApplications: z.coerce.number().int().min(1).max(20),
  maxDebt: z.coerce.number().int().min(0),
  isRateValidated: z.literal("on").optional(),
  isEnabled: z.literal("on").optional()
});

export async function updatePenaltySettings(formData: FormData) {
  const session = await requireWriteAccess("settings:manage");
  const parsed = penaltySchema.safeParse(Object.fromEntries(formData));
  const back = (message: string): never => redirect(`/admin?erreur=${encodeURIComponent(message)}`);
  if (!parsed.success) back(parsed.error.issues[0]?.message ?? "Saisie invalide");
  const data = parsed.data!;
  const validated = data.isRateValidated === "on" && data.percent !== null;
  const enabled = data.isEnabled === "on" && validated;
  if (data.isEnabled === "on" && !validated) back("Impossible d’activer l’automatisation sans taux défini et validé");
  const previous = await prisma.appSetting.findUnique({ where: { key: "latePenalty" } });
  const value = {
    latePenaltyPercentBps: data.percent, latePenaltyBasis: data.basis, latePenaltyFrequencyRpYears: 1,
    maxPenaltyApplications: data.maxApplications, maxAssessmentDebt: String(data.maxDebt), isPenaltyAutomationEnabled: enabled, isRateValidated: validated
  };
  await prisma.$transaction(async (tx) => {
    await tx.appSetting.upsert({ where: { key: "latePenalty" }, create: { key: "latePenalty", value, updatedById: session.userId }, update: { value, version: { increment: 1 }, updatedById: session.userId } });
    await writeAudit(tx, { actorId: session.userId, action: "PENALTY_SETTINGS_UPDATED", entityType: "AppSetting", entityId: "latePenalty", previousValues: previous?.value ?? undefined, newValues: value });
  });
  redirect("/admin");
}

const approvalSchema = z.object({ amount: z.coerce.number().int().min(0), isValidated: z.literal("on").optional() });

export async function updateApprovalThreshold(formData: FormData) {
  const session = await requireWriteAccess("settings:manage");
  const parsed = approvalSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`/admin?erreur=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Saisie invalide")}`);
  const value = { amount: String(parsed.data!.amount), isValidated: parsed.data!.isValidated === "on" };
  const previous = await prisma.appSetting.findUnique({ where: { key: "approvalThreshold" } });
  await prisma.$transaction(async (tx) => {
    await tx.appSetting.upsert({ where: { key: "approvalThreshold" }, create: { key: "approvalThreshold", value, updatedById: session.userId }, update: { value, version: { increment: 1 }, updatedById: session.userId } });
    await writeAudit(tx, { actorId: session.userId, action: "APPROVAL_THRESHOLD_UPDATED", entityType: "AppSetting", entityId: "approvalThreshold", previousValues: previous?.value ?? undefined, newValues: value });
  });
  redirect("/admin");
}

const exemptionPolicyFormSchema = z.object({
  coveragePercent: z.string().trim()
    .min(1, "Le taux d’application est obligatoire")
    .transform((value) => Number(value.replace(",", ".")))
    .pipe(z.number().finite().min(0, "Le taux minimum est 0 %").max(100, "Le taux maximum est 100 %"))
    .transform((value) => Math.round(value * 100))
});

export async function updateExemptionPolicy(formData: FormData) {
  const session = await requireWriteAccess("settings:manage");
  const parsed = exemptionPolicyFormSchema.safeParse({ coveragePercent: formData.get("coveragePercent") });
  if (!parsed.success) redirect(`/admin?erreur=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Taux d’exonération invalide")}`);
  const value = { weeklyTaxCoverageBps: parsed.data!.coveragePercent };
  let covered = 0n;
  let coveredNinjas = 0;
  await prisma.$transaction(async (tx) => {
    // Global order for credit consumers: NinjaProfile rows, then AppSetting.
    // Locking every active ninja also drains transactions using the old rate
    // before the administrative change can commit.
    const ninjas = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "NinjaProfile"
      WHERE "status" = 'ACTIVE'
      ORDER BY "id"
      FOR UPDATE
    `;
    const previous = await tx.appSetting.findUnique({ where: { key: EXEMPTION_POLICY_SETTING_KEY } });
    const updated = await tx.appSetting.upsert({
      where: { key: EXEMPTION_POLICY_SETTING_KEY },
      create: { key: EXEMPTION_POLICY_SETTING_KEY, value, updatedById: session.userId },
      update: { value, version: { increment: 1 }, updatedById: session.userId }
    });
    if (value.weeklyTaxCoverageBps > 0) {
      for (const ninja of ninjas) {
        const used = await autoCoverOpenTaxes(tx, ninja.id, session.userId, `policy-change:v${updated.version}`);
        if (used > 0n) { covered += used; coveredNinjas++; }
      }
    }
    await writeAudit(tx, {
      actorId: session.userId,
      action: "EXEMPTION_POLICY_UPDATED",
      entityType: "AppSetting",
      entityId: EXEMPTION_POLICY_SETTING_KEY,
      reason: `Part maximale d’une taxe couverte par le crédit : ${(value.weeklyTaxCoverageBps / 100).toLocaleString("fr-FR")} % — soldes ninja conservés${covered > 0n ? `, ${covered.toLocaleString("fr-FR")} ¥ appliqués sur ${coveredNinjas} dossier(s)` : ""}`,
      previousValues: previous?.value ?? undefined,
      newValues: { ...value, appliedExistingCredit: String(covered), affectedNinjas: coveredNinjas }
    });
  }, { timeout: 180_000, maxWait: 15_000 });
  const message = value.weeklyTaxCoverageBps === 0
    ? "Application du crédit suspendue à 0 % — tous les soldes d’exonération sont conservés"
    : `Application du crédit réglée à ${(value.weeklyTaxCoverageBps / 100).toLocaleString("fr-FR")} % par semaine${covered > 0n ? ` — ${covered.toLocaleString("fr-FR")} ¥ appliqués sur ${coveredNinjas} dossier(s) ouvert(s)` : " — crédits conservés, aucune dette ouverte supplémentaire couverte"}`;
  redirect(`/admin?info=${encodeURIComponent(message)}`);
}

/** Publishes a new weekly-tax scale (one amount per grade, historized as a new policy
 *  version) and immediately rebills the current RP week at the new amounts. Lines already
 *  touched (payments, exemptions, penalties, adjustments) and the old register's
 *  advance-paid weeks are left untouched; regenerated taxes apply at most the
 *  administratively configured share of available exemption credit. */
export async function updateTaxRates(formData: FormData) {
  const session = await requireWriteAccess("settings:manage");
  const back = (message: string): never => redirect(`/admin?erreur=${encodeURIComponent(message)}`);
  const grades = await prisma.ninjaGrade.findMany({ where: { isActive: true, code: { not: "UNKNOWN" } }, orderBy: { sortOrder: "asc" } });
  const rates = new Map<string, bigint>();
  for (const grade of grades) {
    const raw = formData.get(`rate_${grade.id}`);
    if (typeof raw !== "string" || raw.trim() === "") back(`Montant manquant pour ${grade.label}`);
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 100_000_000) back(`Montant invalide pour ${grade.label} (entier en Ryō)`);
    rates.set(grade.id, BigInt(value));
  }
  const service = await getRpService();
  const rpYear = service.currentRpYear();
  let version = 0, rebilled = 0, exempted = 0, unchanged = false;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(621714423)`;
    const active = await tx.taxPolicy.findFirst({ where: { isActive: true }, include: { rates: true } });
    if (active && grades.every((grade) => (active.rates.find((rate) => rate.gradeId === grade.id)?.amount ?? 0n) === rates.get(grade.id))) {
      unchanged = true;
      return;
    }
    // Serialize billing with every lifecycle update, including activation and
    // restoration of a currently non-active dossier.
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "NinjaProfile"
      ORDER BY "id"
      FOR UPDATE
    `;
    const name = active?.name ?? "Barème Kōeki";
    const latest = await tx.taxPolicy.findFirst({ where: { name }, orderBy: { version: "desc" } });
    version = (latest?.version ?? 0) + 1;
    await tx.taxPolicy.updateMany({ where: { isActive: true }, data: { isActive: false, effectiveToRpYear: rpYear } });
    const policy = await tx.taxPolicy.create({ data: { name, version, effectiveFromRpYear: rpYear, isActive: true, rates: { createMany: { data: grades.map((grade) => ({ gradeId: grade.id, amount: rates.get(grade.id)! })) } } } });
    const year = await tx.taxYear.findUnique({ where: { rpYear } });
    if (year) {
      const untouched = await tx.taxAssessment.findMany({ where: {
        taxYearId: year.id, taxPolicy: { name: { not: "Ancien registre" } },
        ninja: { status: "ACTIVE" },
        status: { in: ["UPCOMING", "DUE"] },
        allocations: { none: {} }, exemptions: { none: {} }, penalties: { none: {} }, adjustments: { none: {} }
      }, select: { id: true } });
      if (untouched.length) await tx.taxAssessment.deleteMany({ where: { id: { in: untouched.map((entry) => entry.id) } } });
      const ninjas = await tx.ninjaProfile.findMany({ where: { status: "ACTIVE", currentGrade: { code: { not: "UNKNOWN" } } }, include: { currentGrade: true } });
      const result = await tx.taxAssessment.createMany({ data: ninjas.map((ninja) => ({
        ninjaId: ninja.id, taxYearId: year.id, taxPolicyId: policy.id, gradeCodeSnapshot: ninja.currentGrade.code, gradeLabelSnapshot: ninja.currentGrade.label,
        originalAmount: rates.get(ninja.currentGradeId) ?? 0n, dueAt: year.dueAt, status: year.dueAt > new Date() ? "UPCOMING" as const : "DUE" as const
      })), skipDuplicates: true });
      rebilled = result.count;
      const fresh = await tx.taxAssessment.findMany({ where: { taxYearId: year.id, taxPolicyId: policy.id, ninja: { status: "ACTIVE" }, originalAmount: { gt: 0 } }, select: { id: true, ninjaId: true } });
      for (const assessment of fresh) {
        const covered = await autoCoverOpenTaxes(tx, assessment.ninjaId, session.userId, `policy:${policy.id}`);
        if (covered > 0n) exempted++;
      }
    }
    await writeAudit(tx, { actorId: session.userId, action: "TAX_POLICY_UPDATED", entityType: "TaxPolicy", entityId: policy.id, reason: `Barème v${version} publié — semaine RP ${rpYear} refacturée (${rebilled} taxes régénérées, ${exempted} couvertes par crédit)`, newValues: Object.fromEntries(grades.map((grade) => [grade.label, Number(rates.get(grade.id))])) });
  }, { timeout: 180_000, maxWait: 15_000 });
  if (unchanged) redirect(`/admin?info=${encodeURIComponent("Barème inchangé — rien à faire")}`);
  redirect(`/admin?info=${encodeURIComponent(`Barème v${version} appliqué — ${rebilled} taxes refacturées pour la semaine en cours${exempted ? `, dont ${exempted} couvertes par le crédit d’exonération` : ""}`)}`);
}

/** Opens (or completes) the current RP week for every active ninja at the active scale,
 *  without waiting for Sunday's worker run. Idempotent: existing lines are left alone. */
export async function billCurrentWeek() {
  const session = await requireWriteAccess("settings:manage");
  const service = await getRpService();
  const rpYear = service.currentRpYear();
  let created = 0, repaired = 0, exempted = 0, missingPolicy = false, missingRateLabel: string | null = null;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(621714423)`;
    const policy = await tx.taxPolicy.findFirst({ where: { isActive: true }, include: { rates: true } });
    if (!policy) {
      missingPolicy = true;
      return;
    }
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "NinjaProfile"
      ORDER BY "id"
      FOR UPDATE
    `;
    const ninjas = await tx.ninjaProfile.findMany({ where: { status: "ACTIVE", currentGrade: { code: { not: "UNKNOWN" } } }, include: { currentGrade: true } });
    const rates = new Map(policy.rates.map((rate) => [rate.gradeId, rate.amount]));
    const missingRate = ninjas.find((ninja) => !rates.has(ninja.currentGradeId));
    if (missingRate) {
      missingRateLabel = missingRate.currentGrade.label;
      return;
    }
    const year = await tx.taxYear.upsert({ where: { rpYear }, create: { rpYear, taxPolicyId: policy.id, startsAt: service.startOfRpYear(rpYear), endsAt: service.endOfRpYear(rpYear), dueAt: service.dueAt(rpYear), generatedAt: new Date() }, update: { generatedAt: new Date() } });
    const reconciled = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "TaxAssessment" AS "assessment"
      SET "taxPolicyId" = ${policy.id},
          "gradeCodeSnapshot" = "grade"."code",
          "gradeLabelSnapshot" = "grade"."label",
          "originalAmount" = "rate"."amount",
          "dueAt" = ${year.dueAt},
          "status" = (CASE WHEN "rate"."amount" = 0 THEN 'PAID' WHEN ${year.dueAt} > CURRENT_TIMESTAMP THEN 'UPCOMING' ELSE 'DUE' END)::"TaxAssessmentStatus",
          "version" = "assessment"."version" + 1
      FROM "NinjaProfile" AS "ninja"
      JOIN "NinjaGrade" AS "grade" ON "grade"."id" = "ninja"."currentGradeId"
      JOIN "TaxPolicyGradeRate" AS "rate" ON "rate"."gradeId" = "grade"."id" AND "rate"."taxPolicyId" = ${policy.id}
      WHERE "assessment"."taxYearId" = ${year.id}
        AND "assessment"."ninjaId" = "ninja"."id"
        AND "ninja"."status" = 'ACTIVE'
        AND "grade"."code" <> 'UNKNOWN'
        AND "assessment"."gradeCodeSnapshot" = 'UNKNOWN'
        AND "assessment"."originalAmount" = 0
        AND "assessment"."status" IN ('UPCOMING', 'DUE', 'OVERDUE', 'PARTIALLY_PAID', 'PAID')
        AND NOT EXISTS (SELECT 1 FROM "TaxPaymentAllocation" WHERE "assessmentId" = "assessment"."id")
        AND NOT EXISTS (SELECT 1 FROM "TaxExemption" WHERE "assessmentId" = "assessment"."id")
        AND NOT EXISTS (SELECT 1 FROM "TaxPenalty" WHERE "assessmentId" = "assessment"."id")
        AND NOT EXISTS (SELECT 1 FROM "TaxAdjustment" WHERE "assessmentId" = "assessment"."id")
      RETURNING "assessment"."id"
    `;
    repaired = reconciled.length;
    const result = await tx.taxAssessment.createMany({ data: ninjas.map((ninja) => ({
      ninjaId: ninja.id, taxYearId: year.id, taxPolicyId: policy.id, gradeCodeSnapshot: ninja.currentGrade.code, gradeLabelSnapshot: ninja.currentGrade.label,
      originalAmount: rates.get(ninja.currentGradeId) ?? 0n, dueAt: year.dueAt, status: year.dueAt > new Date() ? "UPCOMING" as const : "DUE" as const
    })), skipDuplicates: true });
    created = result.count;
    const fresh = await tx.taxAssessment.findMany({ where: { taxYearId: year.id, ninja: { status: "ACTIVE" }, originalAmount: { gt: 0 }, status: { in: ["UPCOMING", "DUE"] } }, select: { id: true, ninjaId: true } });
    for (const assessment of fresh) {
      const covered = await autoCoverOpenTaxes(tx, assessment.ninjaId, session.userId, `manual-billing:${rpYear}`);
      if (covered > 0n) exempted++;
    }
    const marker = { lastRpYear: rpYear, at: new Date().toISOString() };
    await tx.appSetting.upsert({ where: { key: "taxGeneration" }, create: { key: "taxGeneration", value: marker }, update: { value: marker, version: { increment: 1 } } });
    await writeAudit(tx, { actorId: session.userId, action: "TAX_WEEK_BILLED", entityType: "TaxYear", entityId: year.id, reason: `Semaine RP ${rpYear} ouverte manuellement — ${created} taxes créées, ${repaired} taxes remises au bon grade, ${exempted} couvertes par le crédit d’exonération` });
  }, { timeout: 180_000, maxWait: 15_000 });
  if (missingPolicy) redirect("/admin?erreur=Aucune%20politique%20fiscale%20active");
  if (missingRateLabel) redirect(`/admin?erreur=${encodeURIComponent(`Aucun montant fiscal n’est configuré pour le grade ${missingRateLabel}`)}`);
  redirect(`/admin?info=${encodeURIComponent(created || repaired ? `Semaine RP ${rpYear} facturée — ${created} taxe${created > 1 ? "s" : ""} créée${created > 1 ? "s" : ""}${repaired ? `, ${repaired} remise${repaired > 1 ? "s" : ""} au bon grade` : ""}${exempted ? `, dont ${exempted} couverte${exempted > 1 ? "s" : ""} par le crédit d’exonération` : ""}` : `Semaine RP ${rpYear} déjà facturée pour tous les ninjas dont le grade est renseigné`)}`);
}

export async function revokeUserAccess(formData: FormData) {
  const session = await requireWriteAccess("users:manage");
  const userId = formData.get("userId");
  if (typeof userId !== "string" || !userId) redirect("/admin");
  if (userId === session.userId) redirect("/admin?erreur=Impossible%20de%20r%C3%A9voquer%20votre%20propre%20acc%C3%A8s");
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId as string }, data: { revokedAt: new Date(), sessionVersion: { increment: 1 } } });
    await tx.session.deleteMany({ where: { userId: userId as string } });
    await writeAudit(tx, { actorId: session.userId, action: "USER_ACCESS_REVOKED", entityType: "User", entityId: userId as string });
  });
  redirect("/admin");
}
