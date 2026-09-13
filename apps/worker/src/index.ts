import { randomUUID } from "node:crypto";
import { prisma, type Prisma } from "@koeki/database";
import { assessmentSettlementBreakdown, calculateNextPenalty, createRpTimeService, defaultRpTimeConfig, deriveTaxAssessmentStatus, exemptionUse, parseExemptionPolicy, rpTimeConfigSchema, ryo } from "@koeki/domain";

const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === "P2002";

/** Serializes lifecycle-sensitive writes with administrative status changes. */
async function lockNinja(tx: Prisma.TransactionClient, ninjaId: string) {
  const rows = await tx.$queryRaw<Array<{ status: string; userId: string | null }>>`
    SELECT "status", "userId"
    FROM "NinjaProfile"
    WHERE "id" = ${ninjaId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function rpService() {
  const setting = await prisma.appSetting.findUnique({ where: { key: "rpTime" } });
  const parsed = setting ? rpTimeConfigSchema.safeParse(setting.value) : null;
  return createRpTimeService(parsed?.success ? parsed.data : defaultRpTimeConfig);
}

async function generateTaxes() {
  const service = await rpService(), rpYear = service.currentRpYear();
  const generation = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(621714423)`;
    const policy = await tx.taxPolicy.findFirst({ where: { isActive: true }, include: { rates: { include: { grade: true } } } });
    if (!policy) throw new Error("No active tax policy");
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "NinjaProfile"
      ORDER BY "id"
      FOR UPDATE
    `;
    const ninjas = await tx.ninjaProfile.findMany({ where: { status: "ACTIVE", currentGrade: { code: { not: "UNKNOWN" } } }, include: { currentGrade: true } });
    const rates = new Map(policy.rates.map((rate) => [rate.gradeId, rate.amount]));
    const missingRate = ninjas.find((ninja) => !rates.has(ninja.currentGradeId));
    if (missingRate) throw new Error(`No tax rate configured for grade ${missingRate.currentGrade.code}`);
    // Catch-up is bounded by the last week this job actually billed (imported
    // legacy weeks are not billing runs), so a missed Sunday is filled in
    // without ever back-billing history.
    const marker = await tx.appSetting.findUnique({ where: { key: "taxGeneration" } });
    const lastBilled = (marker?.value as { lastRpYear?: number } | undefined)?.lastRpYear;
    // Revisit the current week on every run so an activation missed by an
    // earlier run can be caught safely by createMany(skipDuplicates).
    const firstYear = lastBilled ? Math.max(Math.min(lastBilled + 1, rpYear), rpYear - 12) : rpYear;
    let created = 0, repaired = 0;
    const years: number[] = [];
    for (let year = firstYear; year <= rpYear; year++) {
      const taxYear = await tx.taxYear.upsert({ where: { rpYear: year }, create: { rpYear: year, taxPolicyId: policy.id, startsAt: service.startOfRpYear(year), endsAt: service.endOfRpYear(year), dueAt: service.dueAt(year), generatedAt: new Date() }, update: {} });
      if (!taxYear.generatedAt) await tx.taxYear.update({ where: { id: taxYear.id }, data: { generatedAt: new Date() } });
      if (year === rpYear) {
        const reconciled = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "TaxAssessment" AS "assessment"
          SET "taxPolicyId" = ${policy.id},
              "gradeCodeSnapshot" = "grade"."code",
              "gradeLabelSnapshot" = "grade"."label",
              "originalAmount" = "rate"."amount",
              "dueAt" = ${taxYear.dueAt},
              "status" = (CASE WHEN "rate"."amount" = 0 THEN 'PAID' WHEN ${taxYear.dueAt} > CURRENT_TIMESTAMP THEN 'UPCOMING' ELSE 'DUE' END)::"TaxAssessmentStatus",
              "version" = "assessment"."version" + 1
          FROM "NinjaProfile" AS "ninja"
          JOIN "NinjaGrade" AS "grade" ON "grade"."id" = "ninja"."currentGradeId"
          JOIN "TaxPolicyGradeRate" AS "rate" ON "rate"."gradeId" = "grade"."id" AND "rate"."taxPolicyId" = ${policy.id}
          WHERE "assessment"."taxYearId" = ${taxYear.id}
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
        repaired += reconciled.length;
      }
      const result = await tx.taxAssessment.createMany({ data: ninjas.map((ninja) => ({ ninjaId: ninja.id, taxYearId: taxYear.id, taxPolicyId: policy.id, gradeCodeSnapshot: ninja.currentGrade.code, gradeLabelSnapshot: ninja.currentGrade.label, originalAmount: rates.get(ninja.currentGradeId) ?? 0n, dueAt: taxYear.dueAt, status: taxYear.dueAt > new Date() ? "UPCOMING" : "DUE" })), skipDuplicates: true });
      created += result.count;
      if (result.count > 0) years.push(year);
    }
    const value = { lastRpYear: rpYear, at: new Date().toISOString() };
    await tx.appSetting.upsert({ where: { key: "taxGeneration" }, create: { key: "taxGeneration", value }, update: { value, version: { increment: 1 } } });
    return { created, repaired, years };
  }, { timeout: 180_000, maxWait: 15_000 });
  const exempted = await autoApplyExemptions(rpYear);
  return { command: "taxes:generate", rpYear, ...generation, exempted };
}

/** Applies stored exemption credit only up to the administrative weekly ceiling.
 * At 0 % it performs no write; nominal ninja balances remain untouched. */
async function autoApplyExemptions(rpYear: number) {
  const policySetting = await prisma.appSetting.findUnique({ where: { key: "exemptionPolicy" } });
  const policy = parseExemptionPolicy(policySetting?.value);
  if (policy.weeklyTaxCoverageBps <= 0) return 0;
  const systemUser = await prisma.user.findFirst({ where: { roles: { some: { role: { code: "SUPER_ADMIN" } } } }, orderBy: { createdAt: "asc" } });
  if (!systemUser) return 0;
  const assessments = await prisma.taxAssessment.findMany({
    where: { ninja: { status: "ACTIVE" }, taxYear: { rpYear }, originalAmount: { gt: 0 }, status: { in: ["UPCOMING", "DUE", "PARTIALLY_PAID", "OVERDUE"] } },
    include: { penalties: { select: { amount: true } }, adjustments: { select: { amount: true } }, exemptions: { select: { amount: true } }, allocations: { select: { amount: true, payment: { select: { status: true } } } } }
  });
  let applied = 0;
  for (const candidate of assessments) {
    try {
      const committed = await prisma.$transaction(async (tx) => {
        const ninja = await lockNinja(tx, candidate.ninjaId);
        if (ninja?.status !== "ACTIVE") return false;
        const lockedSettings = await tx.$queryRaw<Array<{ value: Prisma.JsonValue; version: number }>>`
          SELECT "value", "version" FROM "AppSetting" WHERE "key" = 'exemptionPolicy' FOR SHARE
        `;
        const lockedPolicy = parseExemptionPolicy(lockedSettings[0]?.value);
        if (lockedPolicy.weeklyTaxCoverageBps <= 0) return false;
        const assessment = await tx.taxAssessment.findFirst({
          where: { id: candidate.id, ninjaId: candidate.ninjaId, status: { in: ["UPCOMING", "DUE", "PARTIALLY_PAID", "OVERDUE"] } },
          include: { penalties: { select: { amount: true } }, adjustments: { select: { amount: true } }, exemptions: { select: { amount: true } }, allocations: { select: { amount: true, payment: { select: { status: true } } } } }
        });
        if (!assessment) return false;
        const first = await tx.exemptionLedgerEntry.findUnique({ where: { sourceType_sourceId: { sourceType: "TaxAssessment", sourceId: assessment.id } } });
        const ledgerSourceId = first ? `${assessment.id}:worker:v${lockedSettings[0]?.version ?? 1}` : assessment.id;
        const already = await tx.exemptionLedgerEntry.findUnique({ where: { sourceType_sourceId: { sourceType: "TaxAssessment", sourceId: ledgerSourceId } } });
        if (already) return false;
        const balance = (await tx.exemptionLedgerEntry.aggregate({ where: { ninjaId: assessment.ninjaId }, _sum: { amount: true } }))._sum.amount ?? 0n;
        if (balance <= 0n) return false;
        const paid = assessment.allocations.filter((item) => item.payment.status === "VALIDATED").reduce((sum, item) => sum + item.amount, 0n);
        const gross = assessment.originalAmount
          + assessment.penalties.reduce((sum, item) => sum + item.amount, 0n)
          + assessment.adjustments.reduce((sum, item) => sum + item.amount, 0n);
        const alreadyExempted = assessment.exemptions.reduce((sum, item) => sum + item.amount, 0n);
        const remaining = gross - alreadyExempted - paid;
        if (remaining <= 0n) return false;
        const use = exemptionUse({ availableCredit: balance, remainingDebt: remaining, gross, alreadyExempted, coverageBps: lockedPolicy.weeklyTaxCoverageBps });
        if (use <= 0n) return false;
        await tx.exemptionLedgerEntry.create({ data: { ninjaId: assessment.ninjaId, amount: -use, sourceType: "TaxAssessment", sourceId: ledgerSourceId, reason: `Exonération automatique — taxe année RP ${rpYear}` } });
        await tx.taxExemption.create({ data: { assessmentId: assessment.id, amount: use, reason: "Exonération automatique (crédit de dons/rachats)", grantedById: systemUser.id } });
        const status = deriveTaxAssessmentStatus({
          storedStatus: assessment.status,
          remaining: remaining - use,
          settled: paid + alreadyExempted + use,
          preserveLegacyOverdue: false,
          dueAt: assessment.dueAt,
          now: new Date(),
          assessmentRpYear: rpYear,
          currentRpYear: rpYear
        });
        if (status !== assessment.status) await tx.taxAssessment.update({ where: { id: assessment.id }, data: { status, version: { increment: 1 } } });
        await tx.auditLog.create({ data: { action: "TAX_AUTO_EXEMPTED", entityType: "TaxAssessment", entityId: assessment.id, requestId: randomUUID(), reason: `${use.toLocaleString("fr-FR")} ¥ de crédit appliqués (année RP ${rpYear}, plafond ${(lockedPolicy.weeklyTaxCoverageBps / 100).toLocaleString("fr-FR")} %)` } });
        return true;
      });
      if (committed) applied++;
    } catch (error) { if (!isUniqueViolation(error)) throw error; }
  }
  return applied;
}

async function applyPenalties() {
  const setting = await prisma.appSetting.findUnique({ where: { key: "latePenalty" } });
  const config = setting?.value as { latePenaltyPercentBps?: number; latePenaltyBasis?: "ORIGINAL_TAX"|"REMAINING_PRINCIPAL"|"CURRENT_DEBT"; latePenaltyFrequencyRpYears?: number; maxPenaltyApplications?: number; maxAssessmentDebt?: string; isPenaltyAutomationEnabled?: boolean; isRateValidated?: boolean } | undefined;
  if (!config?.isPenaltyAutomationEnabled || !config.isRateValidated || !config.latePenaltyPercentBps) return { command: "penalties:apply", created: 0, disabled: true };
  const service = await rpService();
  const assessments = await prisma.taxAssessment.findMany({ where: { ninja: { status: "ACTIVE" }, originalAmount: { gt: 0 }, status: { in: ["OVERDUE", "PARTIALLY_PAID", "DUE"] }, dueAt: { lt: new Date() } }, include: { penalties: true, allocations: { include: { payment: { select: { status: true } } } }, adjustments: true, exemptions: true } });
  let created = 0;
  for (const candidate of assessments) {
    try {
      const committed = await prisma.$transaction(async (tx) => {
        const ninja = await lockNinja(tx, candidate.ninjaId);
        if (ninja?.status !== "ACTIVE") return false;
        const assessment = await tx.taxAssessment.findFirst({
          where: { id: candidate.id, originalAmount: { gt: 0 }, status: { in: ["OVERDUE", "PARTIALLY_PAID", "DUE"] }, dueAt: { lt: new Date() } },
          include: { penalties: true, allocations: { include: { payment: { select: { status: true } } } }, adjustments: true, exemptions: true }
        });
        if (!assessment) return false;
        const paid = assessment.allocations.filter((item) => item.payment.status === "VALIDATED").reduce((sum, item) => sum + item.amount, 0n);
        const adjustments = assessment.adjustments.reduce((sum, item) => sum + item.amount, 0n);
        const penaltyTotal = assessment.penalties.reduce((sum, item) => sum + item.amount, 0n);
        const exempted = assessment.exemptions.reduce((sum, item) => sum + item.amount, 0n);
        const { currentDebt, remainingPrincipal } = assessmentSettlementBreakdown({
          original: assessment.originalAmount,
          penalties: penaltyTotal,
          adjustments,
          exemptions: exempted,
          paid
        });
        // Never manufacture a penalty on a ledger-balanced tax whose stored status
        // merely lagged behind its latest payment/exemption entry.
        if (currentDebt <= 0n) {
          if (assessment.status !== "PAID") await tx.taxAssessment.update({ where: { id: assessment.id }, data: { status: "PAID", version: { increment: 1 } } });
          return false;
        }
        const basisAmount = config.latePenaltyBasis === "REMAINING_PRINCIPAL" ? remainingPrincipal : config.latePenaltyBasis === "CURRENT_DEBT" ? currentDebt : assessment.originalAmount;
        const decision = calculateNextPenalty({ originalTax: ryo(assessment.originalAmount), remainingPrincipal: ryo(remainingPrincipal), currentDebt: ryo(currentDebt < 0n ? 0n : currentDebt), appliedPenaltyIndexes: assessment.penalties.map((item) => item.applicationIndex), completeLateYears: service.completeLateYears(assessment.dueAt) }, { latePenaltyPercentBps: config.latePenaltyPercentBps!, latePenaltyBasis: config.latePenaltyBasis ?? "ORIGINAL_TAX", latePenaltyFrequencyRpYears: config.latePenaltyFrequencyRpYears ?? 1, maxPenaltyApplications: config.maxPenaltyApplications ?? 4, maxAssessmentDebt: ryo(config.maxAssessmentDebt ?? "32000"), isPenaltyAutomationEnabled: true, isRateValidated: true });
        if (!decision || decision.amount === 0n) return false;
        await tx.taxPenalty.create({ data: { assessmentId: assessment.id, applicationIndex: decision.index, rpYearApplied: service.currentRpYear(), percentBps: config.latePenaltyPercentBps!, basis: config.latePenaltyBasis ?? "ORIGINAL_TAX", basisAmount, amount: decision.amount } });
        return true;
      });
      if (committed) created++;
    }
    catch (error) { if (!isUniqueViolation(error)) throw error; }
  }
  return { command: "penalties:apply", created, disabled: false };
}

const assessmentStatusLabels: Record<string, string> = { DUE: "à payer", OVERDUE: "en retard", PARTIALLY_PAID: "partiellement payée" };

async function sendReminders() {
  const overdueCandidates = await prisma.taxAssessment.findMany({
    where: { ninja: { status: "ACTIVE" }, dueAt: { lt: new Date() }, status: { in: ["UPCOMING", "DUE", "PARTIALLY_PAID"] }, originalAmount: { gt: 0 } },
    select: { id: true, ninjaId: true }
  });
  let swept = 0;
  for (const candidate of overdueCandidates) {
    const updated = await prisma.$transaction(async (tx) => {
      const ninja = await lockNinja(tx, candidate.ninjaId);
      if (ninja?.status !== "ACTIVE") return false;
      const assessment = await tx.taxAssessment.findFirst({
        where: { id: candidate.id, ninjaId: candidate.ninjaId, dueAt: { lt: new Date() }, status: { in: ["UPCOMING", "DUE", "PARTIALLY_PAID"] } },
        include: { penalties: true, adjustments: true, exemptions: true, allocations: { include: { payment: { select: { status: true } } } } }
      });
      if (!assessment) return false;
      const paid = assessment.allocations.filter((entry) => entry.payment.status === "VALIDATED").reduce((sum, entry) => sum + entry.amount, 0n);
      const remaining = assessment.originalAmount
        + assessment.penalties.reduce((sum, entry) => sum + entry.amount, 0n)
        + assessment.adjustments.reduce((sum, entry) => sum + entry.amount, 0n)
        - assessment.exemptions.reduce((sum, entry) => sum + entry.amount, 0n)
        - paid;
      if (remaining <= 0n) {
        await tx.taxAssessment.update({ where: { id: assessment.id }, data: { status: "PAID", version: { increment: 1 } } });
        return false;
      }
      const result = await tx.taxAssessment.updateMany({ where: { id: candidate.id, ninjaId: candidate.ninjaId, dueAt: { lt: new Date() }, status: { in: ["UPCOMING", "DUE", "PARTIALLY_PAID"] }, originalAmount: { gt: 0 } }, data: { status: "OVERDUE", version: { increment: 1 } } });
      return result.count === 1;
    });
    if (updated) swept++;
  }
  const assessments = await prisma.taxAssessment.findMany({ where: { ninja: { status: "ACTIVE" }, status: { in: ["DUE", "OVERDUE", "PARTIALLY_PAID"] } }, include: { taxYear: { select: { rpYear: true } } } });
  let sent = 0;
  for (const assessment of assessments) {
    const notified = await prisma.$transaction(async (tx) => {
      const ninja = await lockNinja(tx, assessment.ninjaId);
      if (ninja?.status !== "ACTIVE" || !ninja.userId) return false;
      const current = await tx.taxAssessment.findFirst({
        where: { id: assessment.id, ninjaId: assessment.ninjaId, status: { in: ["DUE", "OVERDUE", "PARTIALLY_PAID"] } },
        include: { taxYear: { select: { rpYear: true } } }
      });
      if (!current) return false;
      const title = `Taxe année RP ${current.taxYear.rpYear} ${assessmentStatusLabels[current.status] ?? "à traiter"}`;
      const existing = await tx.notification.findFirst({ where: { userId: ninja.userId, title, status: "UNREAD" } });
      if (existing) return false;
      await tx.notification.create({ data: { userId: ninja.userId, title, body: `Le service économique de Suna vous rappelle votre taxe de l’année RP ${current.taxYear.rpYear} (échéance ${current.dueAt.toISOString().slice(0, 10)}).` } });
      return true;
    });
    if (notified) sent++;
  }
  return { command: "reminders:send", eligible: assessments.length, sent, statusSweep: swept };
}

async function checkInventory() {
  const resources = await prisma.resource.findMany({ where: { isActive: true } });
  const grouped = await prisma.inventoryMovement.groupBy({ by: ["resourceId"], _sum: { quantity: true } });
  const stocks = new Map(grouped.map((entry) => [entry.resourceId, Number(entry._sum.quantity ?? 0)]));
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const managers = await prisma.user.findMany({ where: { revokedAt: null, roles: { some: { role: { code: { in: ["SUPER_ADMIN", "KOEKI_MANAGER"] } } } } }, select: { id: true } });
  const alerts: Array<{ resource: string; stock: number; level: string }> = [];
  for (const resource of resources) {
    const stock = stocks.get(resource.id) ?? 0;
    // A zero threshold means "not configured" — never alert on it.
    const critical = Number(resource.criticalStock);
    const minimum = Number(resource.minimumStock);
    const level = critical > 0 && stock <= critical ? "critical" : minimum > 0 && stock <= minimum ? "low" : null;
    if (!level) continue;
    alerts.push({ resource: resource.code, stock, level });
    const already = await prisma.auditLog.findFirst({ where: { action: "INVENTORY_ALERT", entityType: "Resource", entityId: resource.id, createdAt: { gte: startOfDay } } });
    if (already) continue;
    await prisma.auditLog.create({ data: { action: "INVENTORY_ALERT", entityType: "Resource", entityId: resource.id, reason: `Seuil ${level === "critical" ? "critique" : "bas"} atteint : ${stock} u`, requestId: randomUUID() } });
    for (const manager of managers) await prisma.notification.create({ data: { userId: manager.id, title: `Stock ${level === "critical" ? "critique" : "bas"} : ${resource.name}`, body: `${resource.name} — ${stock} restants (seuil ${level === "critical" ? "critique" : "bas"} : ${Number(level === "critical" ? resource.criticalStock : resource.minimumStock)}).` } });
  }
  return { command: "inventory:check", checked: resources.length, alerts };
}

async function refreshStats() {
  const service = await rpService(), rpYear = service.currentRpYear();
  const assessments = await prisma.taxAssessment.findMany({ where: { ninja: { status: "ACTIVE" }, taxYear: { rpYear }, status: { notIn: ["EXEMPT", "WAIVED", "SUSPENDED", "CANCELLED", "DRAFT"] } }, include: { penalties: true, adjustments: true, exemptions: true, allocations: { include: { payment: { select: { status: true } } } } } });
  // Expected stays gross; taxes covered by exemption credit count as settled alongside ryō payments.
  let expected = 0n, collected = 0n, exempted = 0n;
  for (const assessment of assessments) {
    expected += assessment.originalAmount + assessment.penalties.reduce((sum, item) => sum + item.amount, 0n) + assessment.adjustments.reduce((sum, item) => sum + item.amount, 0n);
    collected += assessment.allocations.filter((item) => item.payment.status === "VALIDATED").reduce((sum, item) => sum + item.amount, 0n);
    exempted += assessment.exemptions.reduce((sum, item) => sum + item.amount, 0n);
  }
  const [payments, transactions] = await Promise.all([
    prisma.taxPayment.count({ where: { ninja: { status: "ACTIVE" }, status: "VALIDATED" } }),
    prisma.resourceTransaction.count({ where: { ninja: { status: "ACTIVE" }, status: "VALIDATED" } })
  ]);
  const value = { refreshedAt: new Date().toISOString(), rpYear, expected: String(expected), collected: String(collected), exempted: String(exempted), recoveryRateBps: expected > 0n ? Number(((collected + exempted) * 10_000n) / expected) : 0, payments, transactions };
  await prisma.appSetting.upsert({ where: { key: "statsSnapshot" }, create: { key: "statsSnapshot", value }, update: { value, version: { increment: 1 } } });
  return { command: "stats:refresh", ...value };
}

/** Posts a consolidated overdue-debt digest to a Discord channel webhook, so
 * economic agents see the recovery queue without opening the app. Purely
 * additive to `sendReminders` (which notifies each ninja in-app) — this is a
 * team-facing summary, not a per-ninja notification. No-ops if unconfigured. */
async function notifyRecoveryDiscord() {
  const webhookUrl = process.env.RECOVERY_WEBHOOK_URL;
  if (!webhookUrl) return { command: "reminders:discord", skipped: true, reason: "RECOVERY_WEBHOOK_URL not set" };
  const minDebt = BigInt(process.env.RECOVERY_WEBHOOK_MIN_DEBT ?? "0");
  const assessments = await prisma.taxAssessment.findMany({
    where: { ninja: { status: "ACTIVE" }, dueAt: { lt: new Date() }, status: { in: ["DUE", "OVERDUE", "PARTIALLY_PAID"] }, originalAmount: { gt: 0 } },
    include: { penalties: true, adjustments: true, exemptions: true, allocations: { include: { payment: { select: { status: true } } } }, ninja: { select: { id: true, firstName: true, lastName: true, code: true } } }
  });
  const debtByNinja = new Map<string, { name: string; code: string; debt: bigint }>();
  for (const assessment of assessments) {
    const paid = assessment.allocations.filter((entry) => entry.payment.status === "VALIDATED").reduce((sum, entry) => sum + entry.amount, 0n);
    const remaining = assessment.originalAmount
      + assessment.penalties.reduce((sum, entry) => sum + entry.amount, 0n)
      + assessment.adjustments.reduce((sum, entry) => sum + entry.amount, 0n)
      - assessment.exemptions.reduce((sum, entry) => sum + entry.amount, 0n)
      - paid;
    if (remaining <= 0n) continue;
    const entry = debtByNinja.get(assessment.ninja.id) ?? { name: `${assessment.ninja.firstName} ${assessment.ninja.lastName}`, code: assessment.ninja.code, debt: 0n };
    entry.debt += remaining;
    debtByNinja.set(assessment.ninja.id, entry);
  }
  const overdue = [...debtByNinja.values()].filter((entry) => entry.debt >= minDebt).sort((a, b) => (b.debt > a.debt ? 1 : b.debt < a.debt ? -1 : 0));
  if (!overdue.length) return { command: "reminders:discord", sent: false, reason: "no overdue debt above threshold" };
  const top = overdue.slice(0, 15);
  const lines = top.map((entry, index) => `**${index + 1}.** ${entry.name} (\`${entry.code}\`) — ${entry.debt.toLocaleString("fr-FR")} ¥`);
  const remainder = overdue.length - top.length;
  const description = lines.join("\n") + (remainder > 0 ? `\n*…et ${remainder} autre${remainder > 1 ? "s" : ""} dossier${remainder > 1 ? "s" : ""}.*` : "");
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [{ title: `Recouvrement — ${overdue.length} dossier${overdue.length > 1 ? "s" : ""} en retard`, description, color: 0xdc2626, timestamp: new Date().toISOString() }] })
  });
  if (!response.ok) throw new Error(`Discord webhook responded ${response.status}`);
  return { command: "reminders:discord", sent: true, count: overdue.length };
}

const commands: Record<string, () => Promise<unknown>> = { "taxes:generate": generateTaxes, "penalties:apply": applyPenalties, "reminders:send": sendReminders, "reminders:discord": notifyRecoveryDiscord, "inventory:check": checkInventory, "stats:refresh": refreshStats };
async function main() {
  const command = process.argv[2] ?? "all";
  const selected = command === "all" ? Object.values(commands) : [commands[command]];
  if (selected.some((item) => !item)) throw new Error(`Unknown worker command: ${command}`);
  // Each job runs independently so one failure never cancels the rest of the weekly batch.
  for (const run of selected) {
    try { console.log(JSON.stringify(await run!())); }
    catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
