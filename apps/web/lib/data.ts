import { cache } from "react";
import { prisma, type Prisma, type TaxAssessmentStatus } from "@koeki/database";
import { allocatePayment, assessmentSettlementBreakdown, buildAgentScores, buildAmountBars, buildNinjaLeaderboard, buildTopResources, createRpTimeService, defaultRpTimeConfig, deriveTaxAssessmentStatus, parseExemptionPolicy, rateBps, rateDeltaBps, rpTimeConfigSchema, ryo, settlementTotals, simulateCraft, summarizeExemptionFlow, summarizeWeekCompliance, type AgentActivity, type DebtLine } from "@koeki/domain";
import { demoAdmin, demoAudit, demoCrafting, demoDashboard, demoEvents, demoInventory, demoNinjaDetail, demoNinjas, demoRecovery, demoReports, demoResources, demoShell, demoStatistics } from "./demo-data";
import { assessmentBadge, assessmentStatusLabels, formatDate, formatDateTime, lateYearsLabel, relativeTime, weekPeriod, type BadgeStatus } from "./format";
import { normalizeReportHistoryRange } from "./report-period";
import { demoMode, hasPermission, roleLabels, type SessionInfo } from "./session";
import type { AdminData, AuditData, CraftingData, DashboardData, EventsData, InventoryData, NinjaDetailData, NinjaRow, NinjasData, RecoveryData, ReportsData, ResourcesData, ShellInfo, StatisticsData } from "./types";

const sumBig = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);
const EXCLUDED: TaxAssessmentStatus[] = ["EXEMPT", "WAIVED", "SUSPENDED", "CANCELLED", "DRAFT"];

export const pointEventLabels: Record<string, string> = {
  TAX_PAYMENT: "Paiement de taxe", ON_TIME_PAYMENT: "Paiement dans les délais", EARLY_PAYMENT: "Paiement anticipé", REGULARIZATION: "Régularisation",
  DONATION: "Don", RESOURCE_SALE: "Vente de ressources", SPECIAL_EVENT: "Événement spécial", MANUAL_ADJUSTMENT: "Ajustement manuel", REVERSAL: "Écriture inverse"
};
export const movementTypeLabels: Record<string, string> = {
  DONATION_IN: "Don", BUYBACK_IN: "Rachat", CRAFT_CONSUMPTION: "Consommation atelier", CRAFT_OUTPUT: "Production atelier",
  MANUAL_ADJUSTMENT: "Ajustement", TRANSFER_IN: "Transfert entrant", TRANSFER_OUT: "Transfert sortant", LOSS: "Perte"
};

export const getRpService = cache(async () => {
  const setting = await prisma.appSetting.findUnique({ where: { key: "rpTime" } });
  const parsed = setting ? rpTimeConfigSchema.safeParse(setting.value) : null;
  return createRpTimeService(parsed?.success ? parsed.data : defaultRpTimeConfig);
});

// Privacy: never surface Discord account names — a linked ninja identity always wins,
// unlinked accounts fall back to their account name (link a fiche to hide it).
const getUserNames = cache(async () => {
  const users = await prisma.user.findMany({ select: { id: true, name: true, ninjaProfile: { select: { firstName: true, lastName: true } } } });
  return new Map(users.map((user) => [user.id, user.ninjaProfile ? `${user.ninjaProfile.firstName} ${user.ninjaProfile.lastName}`.trim() : user.name ?? "Agent Kōeki"]));
});
const shortName = (name: string) => { const [first, second] = name.trim().split(/\s+/); return first && second ? `${first} ${second.charAt(0)}.` : name; };
const ninjaLifecycle = (status: string): { label: string; badge: BadgeStatus } | null =>
  status === "DECEASED" ? { label: "Décédé", badge: "draft" }
  : status === "INACTIVE" ? { label: "Inactif", badge: "pending" }
  : status === "ARCHIVED" ? { label: "Archivé", badge: "draft" }
  : status === "ACTIVE" ? null
  : { label: status, badge: "draft" };

interface AssessmentAggregate { id: string; rpYear: number; gradeCode: string; gradeLabel: string; original: bigint; penalties: bigint; adjustments: bigint; exemptions: bigint; paid: bigint; remaining: bigint; dueAt: Date; status: TaxAssessmentStatus }
interface NinjaAggregate {
  id: string; code: string; firstName: string; lastName: string; alias: string | null; clan: string | null; status: string; diedAt: Date | null;
  gradeCode: string; gradeLabel: string; referenceAgentId: string | null; userId: string | null; notes: string | null;
  points: number; debt: bigint; lateYears: number; legacyLate: number; badge: BadgeStatus; statusLabel: string; due: string; nextDueAt: Date | null; assessments: AssessmentAggregate[];
  lastContactedAt: Date | null;
}

function computeAssessment(assessment: {
  id: string; originalAmount: bigint; dueAt: Date; status: TaxAssessmentStatus; gradeCodeSnapshot: string; gradeLabelSnapshot: string;
  taxYear: { rpYear: number }; penalties: Array<{ amount: bigint }>; adjustments: Array<{ amount: bigint }>; exemptions: Array<{ amount: bigint }>;
  allocations: Array<{ amount: bigint; payment: { status: string } }>;
}, currentRpYear: number, now: Date): AssessmentAggregate {
  const penalties = sumBig(assessment.penalties.map((entry) => entry.amount));
  const adjustments = sumBig(assessment.adjustments.map((entry) => entry.amount));
  const exemptions = sumBig(assessment.exemptions.map((entry) => entry.amount));
  const paid = sumBig(assessment.allocations.filter((entry) => entry.payment.status === "VALIDATED").map((entry) => entry.amount));
  const gross = assessment.originalAmount + penalties + adjustments;
  const remaining = EXCLUDED.includes(assessment.status) ? 0n : gross - exemptions - paid > 0n ? gross - exemptions - paid : 0n;
  // Only a truly empty zero-priced OVERDUE line is legacy history. A normal tax
  // settled entirely by credit must still become PAID.
  const preserveLegacyOverdue = assessment.status === "OVERDUE" && assessment.gradeCodeSnapshot === "ANCIEN" && assessment.originalAmount === 0n
    && penalties === 0n && adjustments === 0n && exemptions === 0n && paid === 0n;
  const status = deriveTaxAssessmentStatus({
    storedStatus: assessment.status,
    remaining,
    settled: paid + exemptions,
    preserveLegacyOverdue,
    dueAt: assessment.dueAt,
    now,
    assessmentRpYear: assessment.taxYear.rpYear,
    currentRpYear
  }) as TaxAssessmentStatus;
  return { id: assessment.id, rpYear: assessment.taxYear.rpYear, gradeCode: assessment.gradeCodeSnapshot, gradeLabel: assessment.gradeLabelSnapshot, original: assessment.originalAmount, penalties, adjustments, exemptions, paid, remaining, dueAt: assessment.dueAt, status };
}

const loadNinjaAggregates = cache(async (): Promise<NinjaAggregate[]> => {
  const [service, ninjas] = await Promise.all([getRpService(), prisma.ninjaProfile.findMany({
    include: {
      currentGrade: true, pointEntries: { select: { points: true } },
      assessments: { include: { penalties: { select: { amount: true } }, adjustments: { select: { amount: true } }, exemptions: { select: { amount: true } }, allocations: { select: { amount: true, payment: { select: { status: true } } } }, taxYear: { select: { rpYear: true } } } }
    }
  })]);
  const now = new Date();
  const currentRpYear = service.currentRpYear(now);
  return ninjas.map((ninja) => {
    const assessments = ninja.assessments.map((assessment) => computeAssessment(assessment, currentRpYear, now))
      // Une échéance postérieure au décès reste dans l'historique, mais ne constitue plus une dette.
      .map((assessment) => ninja.diedAt && assessment.dueAt > ninja.diedAt && !EXCLUDED.includes(assessment.status)
        ? { ...assessment, remaining: 0n, status: "CANCELLED" as TaxAssessmentStatus }
        : assessment)
      .sort((a, b) => b.rpYear - a.rpYear);
    const open = assessments.filter((assessment) => assessment.remaining > 0n);
    const debt = sumBig(open.map((assessment) => assessment.remaining));
    const overdue = open.filter((assessment) => assessment.dueAt < now);
    const lateYears = overdue.length ? Math.max(...overdue.map((assessment) => service.completeLateYears(assessment.dueAt, now))) : 0;
    const upcoming = open.filter((assessment) => assessment.dueAt >= now).sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0];
    const soon = upcoming && upcoming.dueAt.getTime() - now.getTime() < 2 * 86_400_000;
    // Zero-amount weeks kept OVERDUE come from the old register's fresh-start rule ("en tort").
    const legacyLate = assessments.filter((assessment) => assessment.status === "OVERDUE" && assessment.remaining === 0n).length;
    const gradeNeedsUpdate = ninja.currentGrade.code === "UNKNOWN";
    const fiscalBadge: BadgeStatus = overdue.length ? "overdue" : soon ? "warning" : open.length ? "due" : gradeNeedsUpdate ? "warning" : legacyLate ? "warning" : "paid";
    const fiscalStatusLabel = overdue.length ? "En retard" : soon ? "Échéance proche" : open.length ? "À payer" : gradeNeedsUpdate ? "Grade à mettre à jour" : legacyLate ? "Reprise à régulariser" : "À jour";
    const lifecycle = ninjaLifecycle(ninja.status);
    const badge = lifecycle?.badge ?? fiscalBadge;
    const statusLabel = lifecycle?.label ?? fiscalStatusLabel;
    const due = lifecycle ? "—" : overdue.length ? lateYearsLabel(Math.max(1, lateYears)) : upcoming ? `${Math.max(1, Math.ceil((upcoming.dueAt.getTime() - now.getTime()) / 86_400_000))} jours` : gradeNeedsUpdate ? "Paiement non à jour" : legacyLate ? `${legacyLate} sem. ancien registre` : "—";
    return {
      id: ninja.id, code: ninja.code, firstName: ninja.firstName, lastName: ninja.lastName, alias: ninja.alias, clan: ninja.clan, status: ninja.status, diedAt: ninja.diedAt,
      gradeCode: ninja.currentGrade.code, gradeLabel: ninja.currentGrade.label, referenceAgentId: ninja.referenceAgentId, userId: ninja.userId, notes: ninja.notes,
      points: ninja.pointEntries.reduce((total, entry) => total + entry.points, 0), debt, lateYears, legacyLate, badge, statusLabel, due, nextDueAt: upcoming?.dueAt ?? null, assessments,
      lastContactedAt: ninja.lastContactedAt
    };
  });
});

const activePriceMap = cache(async () => {
  const prices = await prisma.resourcePriceHistory.findMany({ where: { effectiveFrom: { lte: new Date() }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }] }, orderBy: { effectiveFrom: "desc" } });
  const map = new Map<string, bigint>();
  for (const price of prices) if (!map.has(price.resourceId)) map.set(price.resourceId, price.pricePerUnit);
  return map;
});

const stockMap = cache(async () => {
  const grouped = await prisma.inventoryMovement.groupBy({ by: ["resourceId"], _sum: { quantity: true } });
  return new Map(grouped.map((entry) => [entry.resourceId, Number(entry._sum.quantity ?? 0)]));
});

export async function getShellInfo(session: SessionInfo | null): Promise<ShellInfo> {
  if (demoMode) return demoShell;
  const [service, aggregates, users] = await Promise.all([getRpService(), loadNinjaAggregates(), getUserNames()]);
  const now = new Date();
  const year = service.currentRpYear(now);
  const firstRole = session?.roles[0];
  return {
    rpYear: year, rpDayLabel: `Mois RP ${Math.min(7, Math.floor(service.progress(now) * 7) + 1)} sur 7`, rpProgress: service.progress(now),
    overdueCount: aggregates.filter((ninja) => ninja.status === "ACTIVE" && ninja.badge === "overdue").length,
    userName: (session ? users.get(session.userId) : null) ?? session?.name ?? "Session inconnue", userRoleLabel: firstRole ? roleLabels[firstRole] : "Sans rôle"
  };
}

export async function getDashboard(session?: SessionInfo): Promise<DashboardData> {
  if (demoMode) return demoDashboard;
  const canReviewReports = session ? hasPermission(session, "reports:review") : false;
  const [service, aggregates, prices, stocks, penaltySetting, reportsToReview, resources] = await Promise.all([
    getRpService(), loadNinjaAggregates(), activePriceMap(), stockMap(),
    prisma.appSetting.findUnique({ where: { key: "latePenalty" } }),
    canReviewReports ? prisma.agentReport.count({ where: { status: "SUBMITTED", authorId: { not: session!.userId } } }) : Promise.resolve(0),
    prisma.resource.findMany({ where: { isActive: true } })
  ]);
  const now = new Date();
  const rpYear = service.currentRpYear(now);
  const activeAggregates = aggregates.filter((ninja) => ninja.status === "ACTIVE");
  const gradesToUpdate = activeAggregates.filter((ninja) => ninja.gradeCode === "UNKNOWN").length;
  const all = activeAggregates.flatMap((ninja) => ninja.assessments).filter((assessment) => assessment.gradeCode !== "UNKNOWN");
  const rate = (year: number) => {
    const rows = all.filter((assessment) => assessment.rpYear === year && !EXCLUDED.includes(assessment.status));
    const totals = settlementTotals(rows);
    return { ...totals, percent: totals.expected > 0n ? Number((totals.settled * 100n) / totals.expected) : rows.length ? 100 : 0 };
  };
  const current = rate(rpYear);
  const previous = rate(rpYear - 1);
  const years = [...new Set(all.map((assessment) => assessment.rpYear))].filter((year) => year <= rpYear).sort((a, b) => a - b).slice(-5);
  const criticalStocks = resources.filter((resource) => Number(resource.criticalStock) > 0 && (stocks.get(resource.id) ?? 0) <= Number(resource.criticalStock)).map((resource) => resource.name);
  const buybacks = await prisma.resourceTransaction.findMany({ where: { type: "BUYBACK", status: "VALIDATED", createdAt: { gte: service.startOfRpYear(rpYear) } }, select: { totalAmount: true } });
  const penaltyConfig = penaltySetting?.value as { latePenaltyPercentBps?: number | null; isRateValidated?: boolean } | undefined;
  const [payments, transactions] = await Promise.all([
    prisma.taxPayment.findMany({ orderBy: { createdAt: "desc" }, take: 6, include: { ninja: true } }),
    prisma.resourceTransaction.findMany({ orderBy: { createdAt: "desc" }, take: 6, include: { ninja: true } })
  ]);
  const activity = [
    ...payments.map((payment) => ({ code: payment.receiptNumber, label: "Paiement de taxe", subject: `${payment.ninja.firstName} ${payment.ninja.lastName}`, ninjaId: payment.ninja.id, amount: payment.amount, direction: "in" as const, createdAt: payment.createdAt, statusLabel: payment.status === "VALIDATED" ? "Validée" : payment.status === "REVERSED" ? "Contre-passée" : "En attente", status: (payment.status === "VALIDATED" ? "paid" : "pending") as BadgeStatus })),
    ...transactions.map((transaction) => ({ code: transaction.receiptNumber, label: transaction.type === "BUYBACK" ? "Rachat de ressources" : "Don enregistré", subject: `${transaction.ninja.firstName} ${transaction.ninja.lastName}`, ninjaId: transaction.ninja.id, amount: transaction.totalAmount, direction: (transaction.type === "BUYBACK" ? "out" : "in") as "in" | "out", createdAt: transaction.createdAt, statusLabel: transaction.status === "VALIDATED" ? "Validée" : transaction.status === "PENDING_APPROVAL" ? "À valider" : "En attente", status: (transaction.status === "VALIDATED" ? "paid" : "pending") as BadgeStatus }))
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 6)
    .map(({ createdAt, ...row }) => ({ ...row, at: relativeTime(createdAt, now) }));
  const stockValue = sumBig(resources.map((resource) => BigInt(Math.max(0, Math.round(stocks.get(resource.id) ?? 0))) * (prices.get(resource.id) ?? 0n)));
  const overdueNinjas = activeAggregates.filter((ninja) => ninja.badge === "overdue");
  return {
    rpYear, expected: current.expected, collected: current.collected, exempted: current.exempted, debt: sumBig(activeAggregates.map((ninja) => ninja.debt)),
    buybacks: sumBig(buybacks.map((entry) => entry.totalAmount)), buybackCount: buybacks.length, stockValue, criticalCount: criticalStocks.length, overdueNinjas: overdueNinjas.length,
    recoveryRateBps: current.expected > 0n ? Number((current.settled * 10_000n) / current.expected) : 0,
    previousDeltaBps: previous.expected > 0n ? (current.expected > 0n ? Number((current.settled * 10_000n) / current.expected) - Number((previous.settled * 10_000n) / previous.expected) : null) : null,
    recoveryByYear: years.map((year) => ({ rpYear: year, percent: rate(year).percent })),
    priorities: {
      penaltyRateMissing: !penaltyConfig?.latePenaltyPercentBps || !penaltyConfig.isRateValidated,
      gradesToUpdate,
      overdueCount: overdueNinjas.length, overdueOldCount: overdueNinjas.filter((ninja) => ninja.lateYears >= 2).length,
      criticalStocks, reportsToReview
    },
    activity
  };
}

export async function getNinjas(params: { q?: string | undefined; grade?: string | undefined; statut?: string | undefined; page?: number | undefined }): Promise<NinjasData> {
  if (demoMode) return demoNinjas;
  const [aggregates, users, grades] = await Promise.all([loadNinjaAggregates(), getUserNames(), prisma.ninjaGrade.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } })]);
  const query = params.q?.trim().toLowerCase();
  const registry = aggregates.filter((ninja) => ninja.status !== "ARCHIVED");
  let rows = params.statut === "archived" ? aggregates.filter((ninja) => ninja.status === "ARCHIVED") : registry;
  if (query) rows = rows.filter((ninja) => [`${ninja.firstName} ${ninja.lastName}`, ninja.code, ninja.alias ?? ""].some((value) => value.toLowerCase().includes(query)));
  if (params.grade) rows = rows.filter((ninja) => ninja.gradeCode === params.grade);
  if (params.statut === "deceased") rows = rows.filter((ninja) => ninja.status === "DECEASED");
  else if (params.statut === "inactive") rows = rows.filter((ninja) => ninja.status === "INACTIVE");
  else if (params.statut === "archived") rows = rows.filter((ninja) => ninja.status === "ARCHIVED");
  else if (params.statut === "grade_missing") rows = rows.filter((ninja) => ninja.status === "ACTIVE" && ninja.gradeCode === "UNKNOWN");
  else if (params.statut === "warning") rows = rows.filter((ninja) => ninja.status === "ACTIVE" && ninja.gradeCode !== "UNKNOWN" && ninja.badge === "warning");
  else if (params.statut) rows = rows.filter((ninja) => ninja.status === "ACTIVE" && ninja.badge === params.statut);
  rows = [...rows].sort((a, b) => (b.debt > a.debt ? 1 : b.debt < a.debt ? -1 : a.lastName.localeCompare(b.lastName)));
  const total = rows.length;
  const activeAggregates = registry.filter((ninja) => ninja.status === "ACTIVE");
  const upToDate = activeAggregates.filter((ninja) => ninja.badge === "paid").length;
  const needsUpdate = activeAggregates.filter((ninja) => ninja.gradeCode === "UNKNOWN").length;
  const overdue = activeAggregates.filter((ninja) => ninja.badge === "overdue").length;
  const deceased = registry.filter((ninja) => ninja.status === "DECEASED").length;
  const debt = sumBig(activeAggregates.map((ninja) => ninja.debt));
  return {
    summaryLine: `${registry.length} dossier${registry.length > 1 ? "s" : ""} · ${upToDate} à jour · ${needsUpdate} grade${needsUpdate > 1 ? "s" : ""} à mettre à jour · ${overdue} en retard · ${deceased} décédé${deceased > 1 ? "s" : ""} · ${new Intl.NumberFormat("fr-FR").format(Number(debt))} Ryō dus`,
    stats: { total: registry.length, upToDate, needsUpdate, overdue, deceased, debt },
    grades: grades.map((grade) => ({ code: grade.code, label: grade.label })),
    ninjas: rows.map((ninja): NinjaRow => ({
      id: ninja.id, code: ninja.code, name: `${ninja.firstName} ${ninja.lastName}`, alias: ninja.alias, grade: ninja.gradeLabel, points: ninja.points,
      debt: ninja.debt, badge: ninja.badge, statusLabel: ninja.statusLabel, agent: ninja.referenceAgentId ? shortName(users.get(ninja.referenceAgentId) ?? "—") : "—", due: ninja.due
    })),
    total, page: 1, pageCount: 1
  };
}

/** Fresh, uncached fiscal lines for one ninja — pass the transaction client to read post-lock state. */
export async function loadNinjaFiscal(ninjaId: string, client: Pick<typeof prisma, "ninjaProfile"> = prisma): Promise<AssessmentAggregate[] | null> {
  const service = await getRpService();
  const ninja = await client.ninjaProfile.findUnique({
    where: { id: ninjaId },
    include: { assessments: { include: { penalties: { select: { amount: true } }, adjustments: { select: { amount: true } }, exemptions: { select: { amount: true } }, allocations: { select: { amount: true, payment: { select: { status: true } } } }, taxYear: { select: { rpYear: true } } } } }
  });
  if (!ninja) return null;
  const now = new Date();
  return ninja.assessments.map((assessment) => computeAssessment(assessment, service.currentRpYear(now), now));
}

export function buildDebtLines(assessments: AssessmentAggregate[]): Array<DebtLine & { label: string }> {
  return assessments.filter((assessment) => assessment.remaining > 0n).sort((a, b) => a.rpYear - b.rpYear).flatMap((assessment) => {
    const { remainingPenalty: penaltyRemaining, remainingPrincipal: principalRemaining } = assessmentSettlementBreakdown({
      original: assessment.original,
      penalties: assessment.penalties,
      adjustments: assessment.adjustments,
      exemptions: assessment.exemptions,
      paid: assessment.paid
    });
    const lines: Array<DebtLine & { label: string }> = [];
    if (penaltyRemaining > 0n) lines.push({ id: `${assessment.id}:PENALTY`, assessmentId: assessment.id, rpYear: assessment.rpYear, kind: "PENALTY", remaining: ryo(penaltyRemaining), label: `Majoration année ${assessment.rpYear}` });
    if (principalRemaining > 0n) lines.push({ id: `${assessment.id}:PRINCIPAL`, assessmentId: assessment.id, rpYear: assessment.rpYear, kind: "PRINCIPAL", remaining: ryo(principalRemaining), label: `Taxe année ${assessment.rpYear}` });
    return lines;
  });
}

export async function getNinjaDetail(id: string, options: { previewAmount?: bigint | undefined; canSeeNotes: boolean }): Promise<NinjaDetailData | null> {
  if (demoMode) return { ...demoNinjaDetail, preview: options.previewAmount ? { amount: options.previewAmount, lines: [{ label: "Taxe année 46", amount: options.previewAmount }], unallocated: 0n } : null };
  const aggregates = await loadNinjaAggregates();
  const ninja = aggregates.find((entry) => entry.id === id);
  if (!ninja) return null;
  const currentRpYear = (await getRpService()).currentRpYear();
  const [grades, entries, payments, transactions, linked, exemptionGrantedRow, exemptionDebitedRow] = await Promise.all([
    prisma.ninjaGrade.findMany({ where: { isActive: true, code: { not: "UNKNOWN" } }, orderBy: { sortOrder: "asc" } }),
    prisma.pointLedgerEntry.findMany({ where: { ninjaId: id }, orderBy: { createdAt: "desc" }, take: 12 }),
    prisma.taxPayment.findMany({ where: { ninjaId: id }, orderBy: { createdAt: "desc" }, take: 12 }),
    prisma.resourceTransaction.findMany({ where: { ninjaId: id }, orderBy: { createdAt: "desc" }, take: 12 }),
    ninjaHasLinkedUser(id),
    prisma.exemptionLedgerEntry.aggregate({ where: { ninjaId: id, amount: { gt: 0n } }, _sum: { amount: true } }),
    prisma.exemptionLedgerEntry.aggregate({ where: { ninjaId: id, amount: { lt: 0n } }, _sum: { amount: true } })
  ]);
  const debtLines = buildDebtLines(ninja.assessments);
  const preview = options.previewAmount && options.previewAmount > 0n
    ? (() => { const result = allocatePayment(ryo(options.previewAmount), debtLines); return { amount: options.previewAmount!, lines: result.allocations.map((allocation) => ({ label: debtLines.find((line) => line.id === allocation.debtLineId)?.label ?? "Dette", amount: allocation.amount as bigint })), unallocated: result.unallocated as bigint }; })()
    : null;
  const operations = [
    ...payments.map((payment) => ({ id: payment.id, receipt: payment.receiptNumber, label: "Paiement de taxe", amount: payment.amount, createdAt: payment.createdAt, statusLabel: payment.status === "VALIDATED" ? "Validée" : payment.status === "REVERSED" ? "Contre-passée" : "En attente", badge: (payment.status === "VALIDATED" ? "paid" : "pending") as BadgeStatus })),
    ...transactions.map((transaction) => ({ id: transaction.id, receipt: transaction.receiptNumber, label: transaction.type === "BUYBACK" ? "Rachat de ressources" : "Don", amount: transaction.totalAmount, createdAt: transaction.createdAt, statusLabel: transaction.status === "VALIDATED" ? "Validée" : "À valider", badge: (transaction.status === "VALIDATED" ? "paid" : "pending") as BadgeStatus }))
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 12).map(({ createdAt, ...row }) => ({ ...row, at: formatDate(createdAt) }));
  const lifecycle = ninjaLifecycle(ninja.status);
  const exemptionGranted = exemptionGrantedRow._sum.amount ?? 0n;
  const exemptionUsed = -(exemptionDebitedRow._sum.amount ?? 0n);
  return {
    id: ninja.id, code: ninja.code, name: `${ninja.firstName} ${ninja.lastName}`, alias: ninja.alias, clan: ninja.clan,
    lifecycleStatus: ninja.status, statusLabel: lifecycle?.label ?? "Actif", diedAt: ninja.diedAt ? formatDate(ninja.diedAt) : null,
    grade: { code: ninja.gradeCode, label: ninja.gradeLabel }, grades: grades.map((grade) => ({ id: grade.id, code: grade.code, label: grade.label })),
    hasLinkedUser: linked, notes: options.canSeeNotes ? ninja.notes : null,
    totalDebt: ninja.debt, lateYears: ninja.lateYears, nextDue: ninja.badge === "overdue" ? "Dépassée" : ninja.nextDueAt ? formatDate(ninja.nextDueAt) : "—", pointsBalance: ninja.points,
    exemptionBalance: exemptionGranted - exemptionUsed, exemptionGranted, exemptionUsed,
    assessments: [...ninja.assessments]
      // Current week first, then history newest-first, then weeks paid in advance last:
      // an agent works on today, not on next December's prepaid lines.
      .sort((a, b) => {
        const future = (row: typeof a) => (row.rpYear > currentRpYear ? 1 : 0);
        return future(a) - future(b) || (future(a) ? a.rpYear - b.rpYear : b.rpYear - a.rpYear);
      })
      .map((assessment) => {
      // A zero-rate grade owes nothing: saying "Payée" would suggest money changed hands.
      const gradeUnresolved = assessment.gradeCode === "UNKNOWN";
      const notTaxable = assessment.original === 0n && assessment.paid === 0n && assessment.penalties === 0n && assessment.gradeLabel !== "Ancien registre";
      return { id: assessment.id, rpYear: assessment.rpYear, period: weekPeriod(assessment.dueAt), gradeLabel: assessment.gradeLabel, original: assessment.original, penalties: assessment.penalties, adjustments: assessment.adjustments, exemptions: assessment.exemptions, paid: assessment.paid, remaining: assessment.remaining, statusLabel: gradeUnresolved ? "En attente du grade" : notTaxable ? "Non imposable" : assessmentStatusLabels[assessment.status], badge: gradeUnresolved ? ("pending" as BadgeStatus) : notTaxable ? ("draft" as BadgeStatus) : assessmentBadge(assessment.status), dueAt: formatDate(assessment.dueAt) };
    }),
    pointEntries: entries.map((entry) => ({ id: entry.id, at: formatDate(entry.createdAt), label: pointEventLabels[entry.eventType] ?? entry.eventType, points: entry.points, reason: entry.reason })),
    operations, preview
  };
}

// Whether a Discord account is linked — the account name itself is never exposed.
async function ninjaHasLinkedUser(ninjaId: string) {
  const profile = await prisma.ninjaProfile.findUnique({ where: { id: ninjaId }, select: { userId: true } });
  return Boolean(profile?.userId);
}

export async function getRecovery(): Promise<RecoveryData> {
  if (demoMode) return demoRecovery;
  const [aggregates, users] = await Promise.all([loadNinjaAggregates(), getUserNames()]);
  const active = aggregates.filter((ninja) => ninja.status === "ACTIVE");
  const overdue = active.filter((ninja) => ninja.badge === "overdue").sort((a, b) => b.lateYears - a.lateYears || (b.debt > a.debt ? 1 : -1));
  const legacyOnly = active.filter((ninja) => ninja.badge !== "overdue" && ninja.legacyLate > 0).sort((a, b) => b.legacyLate - a.legacyLate);
  const critical = overdue.filter((ninja) => ninja.lateYears >= 2);
  const averageLate = overdue.length ? (overdue.reduce((total, ninja) => total + ninja.lateYears, 0) / overdue.length).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) : "0";
  const agentName = (ninja: NinjaAggregate) => (ninja.referenceAgentId ? shortName(users.get(ninja.referenceAgentId) ?? "—") : "À attribuer");
  return {
    metrics: {
      priorityDebt: sumBig(critical.map((ninja) => ninja.debt)), priorityCount: critical.length, averageLate: `${averageLate} ans RP`,
      totalDebt: sumBig(overdue.map((ninja) => ninja.debt)), unassigned: legacyOnly.length
    },
    rows: [
      ...overdue.map((ninja) => ({ id: ninja.id, name: `${ninja.firstName} ${ninja.lastName}`, code: ninja.code, debt: ninja.debt, legacyWeeks: ninja.legacyLate, due: ninja.due, agent: agentName(ninja), lastContactedAt: ninja.lastContactedAt ? formatDate(ninja.lastContactedAt) : null })),
      ...legacyOnly.map((ninja) => ({ id: ninja.id, name: `${ninja.firstName} ${ninja.lastName}`, code: ninja.code, debt: 0n, legacyWeeks: ninja.legacyLate, due: ninja.due, agent: agentName(ninja), lastContactedAt: ninja.lastContactedAt ? formatDate(ninja.lastContactedAt) : null }))
    ]
  };
}

export async function markNinjasContacted(agentId: string, ninjaIds: string[]): Promise<number> {
  if (!ninjaIds.length) return 0;
  const result = await prisma.ninjaProfile.updateMany({ where: { id: { in: ninjaIds }, status: "ACTIVE" }, data: { lastContactedAt: new Date(), lastContactedById: agentId } });
  return result.count;
}

const normalizeName = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("fr-FR");

/** Zenkai characters matching a name search that don't have a koeki fiche yet —
 * shown alongside the registry search so agents can reach anyone directly by
 * name, no manual "create a fiche first" step required. */
export async function searchUnfiledZenkaiCharacters(query: string): Promise<Array<{ charKey: string; name: string; rank: string }>> {
  if (demoMode || !query.trim()) return [];
  const { searchSunaCharacters, rankLabel } = await import("./zenkai");
  const [result, aggregates] = await Promise.all([searchSunaCharacters({ q: query }), loadNinjaAggregates()]);
  const knownNames = new Set(aggregates.filter((ninja) => ninja.status !== "ARCHIVED").map((ninja) => normalizeName(`${ninja.firstName} ${ninja.lastName}`)));
  return result.characters.filter((character) => !knownNames.has(normalizeName(character.name)))
    .map((character) => ({ charKey: character.charKey, name: character.name, rank: rankLabel(character.rank) }));
}

export interface ResourceFilterParams { q?: string | undefined; categorie?: string | undefined; besoin?: string | undefined; etat?: string | undefined }

export async function getResources(canApprove: boolean, params: ResourceFilterParams = {}): Promise<ResourcesData> {
  if (demoMode) return demoResources;
  const [service, prices, stocks, resources, categories] = await Promise.all([getRpService(), activePriceMap(), stockMap(), prisma.resource.findMany({ include: { category: true }, orderBy: { name: "asc" } }), prisma.resourceCategory.findMany({ orderBy: { label: "asc" } })]);
  const since = service.startOfRpYear(service.currentRpYear());
  const [buybacks, donations, pending] = await Promise.all([
    prisma.resourceTransaction.findMany({ where: { type: "BUYBACK", status: "VALIDATED", createdAt: { gte: since } }, select: { totalAmount: true } }),
    prisma.resourceTransaction.findMany({ where: { type: "DONATION", status: "VALIDATED", createdAt: { gte: since } }, select: { totalAmount: true } }),
    canApprove ? prisma.resourceTransaction.findMany({ where: { status: "PENDING_APPROVAL", type: "BUYBACK" }, include: { ninja: true }, orderBy: { createdAt: "asc" } }) : Promise.resolve([])
  ]);
  const query = params.q?.trim().toLowerCase();
  const filtered = resources.filter((resource) =>
    (!query || resource.name.toLowerCase().includes(query) || resource.code.toLowerCase().includes(query))
    && (!params.categorie || resource.category.code === params.categorie)
    && (!params.besoin || resource.demand === params.besoin)
    && (params.etat === "inactives" ? !resource.isActive : params.etat === "toutes" ? true : resource.isActive));
  return {
    metrics: {
      buybackTotal: sumBig(buybacks.map((entry) => entry.totalAmount)), buybackCount: buybacks.length,
      donationValue: sumBig(donations.map((entry) => entry.totalAmount)), donationCount: donations.length,
      activeCount: resources.filter((resource) => resource.isActive).length, totalCount: resources.length
    },
    categories: categories.map((category) => ({ code: category.code, label: category.label })),
    resources: filtered.map((resource) => {
      const stock = stocks.get(resource.id) ?? 0;
      const critical = Number(resource.criticalStock) > 0 && stock <= Number(resource.criticalStock);
      const low = Number(resource.minimumStock) > 0 && stock <= Number(resource.minimumStock);
      return {
        id: resource.id, code: resource.code, name: resource.name, category: resource.category.label,
        points: resource.pointsPerUnit, exemption: resource.exemptionPerUnit,
        price: prices.get(resource.id) ?? 0n, stock,
        badge: (!resource.isActive ? "draft" : critical ? "overdue" : low ? "warning" : "paid") as BadgeStatus,
        stateLabel: !resource.isActive ? "Inactive" : critical ? "Critique" : low ? "Stock bas" : "Disponible",
        demand: (resource.demand === "CRITICAL" || resource.demand === "NEEDED" ? resource.demand : "NONE") as "NONE" | "NEEDED" | "CRITICAL"
      };
    }),
    pendingApprovals: pending.map((transaction) => ({ id: transaction.id, receipt: transaction.receiptNumber, ninjaId: transaction.ninja.id, ninja: `${transaction.ninja.firstName} ${transaction.ninja.lastName}`, total: transaction.totalAmount, at: formatDate(transaction.createdAt) }))
  };
}

export async function getInventory(): Promise<InventoryData> {
  if (demoMode) return demoInventory;
  const [prices, stocks, resources, users] = await Promise.all([activePriceMap(), stockMap(), prisma.resource.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }), getUserNames()]);
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [today, latest] = await Promise.all([
    prisma.inventoryMovement.findMany({ where: { occurredAt: { gte: startOfDay } }, select: { quantity: true } }),
    prisma.inventoryMovement.findMany({ orderBy: { occurredAt: "desc" }, take: 12, include: { resource: true } })
  ]);
  const alerts = resources.flatMap((resource): InventoryData["alerts"] => {
    const stock = stocks.get(resource.id) ?? 0;
    const critical = Number(resource.criticalStock);
    const minimum = Number(resource.minimumStock);
    if (critical > 0 && stock <= critical) return [{ id: resource.id, name: resource.name, stock, level: "critical", threshold: critical }];
    if (minimum > 0 && stock <= minimum) return [{ id: resource.id, name: resource.name, stock, level: "low", threshold: minimum }];
    return [];
  }).sort((a, b) => (a.level === b.level ? 0 : a.level === "critical" ? -1 : 1));
  return {
    metrics: {
      stockValue: sumBig(resources.map((resource) => BigInt(Math.max(0, Math.round(stocks.get(resource.id) ?? 0))) * (prices.get(resource.id) ?? 0n))),
      movementsToday: today.length, inToday: today.filter((movement) => Number(movement.quantity) > 0).length, outToday: today.filter((movement) => Number(movement.quantity) < 0).length,
      criticalCount: alerts.filter((alert) => alert.level === "critical").length, lowCount: alerts.filter((alert) => alert.level === "low").length
    },
    alerts,
    movements: latest.map((movement) => ({ id: movement.id, at: formatDateTime(movement.occurredAt), resource: movement.resource.name, type: movementTypeLabels[movement.type] ?? movement.type, quantity: Number(movement.quantity), agent: shortName(users.get(movement.agentId) ?? "Système"), justification: movement.justification })),
    resources: resources.map((resource) => ({ id: resource.id, name: resource.name, stock: stocks.get(resource.id) ?? 0 }))
  };
}

export interface CraftingFilterParams { q?: string | undefined; categorie?: string | undefined }

export async function getCrafting(params: CraftingFilterParams = {}): Promise<CraftingData> {
  if (demoMode) return demoCrafting;
  const [stocks, recipes, executions] = await Promise.all([
    stockMap(),
    prisma.craftRecipe.findMany({ where: { status: "ACTIVE" }, include: { ingredients: { include: { resource: { select: { name: true } } } }, outputs: { include: { resource: { select: { name: true } } } } }, orderBy: [{ category: "asc" }, { name: "asc" }] }),
    prisma.craftExecution.count()
  ]);
  const rows = recipes.map((recipe) => {
    const simulation = simulateCraft(recipe.ingredients.map((ingredient) => ({ resourceId: ingredient.resourceId, quantity: Number(ingredient.quantity) })), [...stocks.entries()].map(([resourceId, quantity]) => ({ resourceId, quantity })));
    const hours = Math.floor(recipe.durationRpMinutes / 60);
    return {
      id: recipe.id, code: recipe.code, name: recipe.name, category: recipe.category, minimumGrade: recipe.minimumGradeCode, cost: recipe.cost,
      craftable: recipe.ingredients.length ? simulation.maximum : 0,
      ingredients: recipe.ingredients.map((ingredient) => ({ name: ingredient.resource.name, quantity: Number(ingredient.quantity) })),
      output: recipe.outputs[0]?.resource.name ?? null,
      duration: hours > 0 ? `${hours} h${recipe.durationRpMinutes % 60 ? ` ${recipe.durationRpMinutes % 60}` : ""} RP` : `${recipe.durationRpMinutes} min RP`, version: recipe.version
    };
  });
  const query = params.q?.trim().toLowerCase();
  const filtered = rows.filter((row) =>
    (!query || row.name.toLowerCase().includes(query) || row.code.toLowerCase().includes(query) || row.ingredients.some((ingredient) => ingredient.name.toLowerCase().includes(query)))
    && (!params.categorie || row.category === params.categorie));
  return {
    metrics: {
      activeCount: recipes.length, categoryCount: new Set(recipes.map((recipe) => recipe.category)).size,
      craftableCount: rows.filter((row) => row.craftable > 0).length, limitedCount: rows.filter((row) => row.craftable === 0).length, executions
    },
    categories: [...new Set(recipes.map((recipe) => recipe.category))].sort((a, b) => a.localeCompare(b)),
    names: recipes.map((recipe) => recipe.name),
    recipes: filtered
  };
}

export async function getStatistics(): Promise<StatisticsData> {
  if (demoMode) return demoStatistics;
  const [service, aggregates, users] = await Promise.all([getRpService(), loadNinjaAggregates(), getUserNames()]);
  const rpYear = service.currentRpYear();
  const since = service.startOfRpYear(rpYear);
  const activeAggregates = aggregates.filter((ninja) => ninja.status === "ACTIVE");
  const all = activeAggregates.flatMap((ninja) => ninja.assessments);
  const currentRows = all.filter((assessment) => assessment.rpYear === rpYear && !EXCLUDED.includes(assessment.status));
  const previousRows = all.filter((assessment) => assessment.rpYear === rpYear - 1 && !EXCLUDED.includes(assessment.status));
  const cycle = settlementTotals(currentRows);
  const previous = settlementTotals(previousRows);
  const debtByGradeMap = new Map<string, bigint>();
  for (const ninja of activeAggregates) if (ninja.debt > 0n) debtByGradeMap.set(ninja.gradeLabel, (debtByGradeMap.get(ninja.gradeLabel) ?? 0n) + ninja.debt);
  const [payments, transactions, points, cyclePoints, exemptionEntries] = await Promise.all([
    prisma.taxPayment.findMany({ where: { status: "VALIDATED", createdAt: { gte: since } }, select: { recordedById: true, amount: true } }),
    prisma.resourceTransaction.findMany({ where: { status: "VALIDATED", createdAt: { gte: since } }, include: { items: { include: { resource: true } } } }),
    prisma.pointLedgerEntry.aggregate({ where: { createdAt: { gte: since }, points: { gt: 0 } }, _sum: { points: true } }),
    prisma.pointLedgerEntry.groupBy({ by: ["ninjaId"], where: { createdAt: { gte: since }, points: { gt: 0 } }, _sum: { points: true } }),
    prisma.exemptionLedgerEntry.findMany({ select: { amount: true, createdAt: true, sourceType: true } })
  ]);
  const agentActivity = new Map<string, AgentActivity>();
  const activityOf = (userId: string) => { const entry = agentActivity.get(userId) ?? { name: users.get(userId) ?? "Agent Kōeki", payments: 0, collected: 0n, donations: 0, buybacks: 0 }; agentActivity.set(userId, entry); return entry; };
  for (const payment of payments) { const entry = activityOf(payment.recordedById); entry.payments++; entry.collected += payment.amount; }
  for (const transaction of transactions) { const entry = activityOf(transaction.agentId); if (transaction.type === "BUYBACK") entry.buybacks++; else entry.donations++; }
  const ninjaNames = new Map(aggregates.map((ninja) => [ninja.id, { id: ninja.id, name: `${ninja.firstName} ${ninja.lastName}`, code: ninja.code }]));
  const ninjaIdsByCode = new Map(aggregates.map((ninja) => [ninja.code, ninja.id]));
  return {
    rpYear, expected: cycle.expected, collected: cycle.collected, exempted: cycle.exempted, remaining: cycle.expected > cycle.settled ? cycle.expected - cycle.settled : 0n,
    rateBps: rateBps(cycle.settled, cycle.expected),
    previousDeltaBps: rateDeltaBps({ expected: cycle.expected, collected: cycle.settled }, { expected: previous.expected, collected: previous.settled }),
    debtByGrade: buildAmountBars([...debtByGradeMap.entries()].map(([label, amount]) => ({ label, amount }))).map((bar) => ({ grade: bar.label, amount: bar.amount, percent: bar.percent })),
    agents: buildAgentScores([...agentActivity.values()]),
    topResources: buildTopResources(transactions.flatMap((transaction) => transaction.items.map((item) => ({ resourceId: item.resourceId, type: transaction.type, name: item.resource.name, quantity: Number(item.quantity) }))))
      .map((row) => ({ name: row.name, typeLabel: row.type === "BUYBACK" ? "Rachat" : "Don", quantity: row.quantity })),
    topNinjas: buildNinjaLeaderboard(cyclePoints.map((entry) => { const ninja = ninjaNames.get(entry.ninjaId); return { name: ninja?.name ?? "Ninja inconnu", code: ninja?.code ?? "—", points: entry._sum.points ?? 0 }; }))
      .map((ninja) => ({ ...ninja, id: ninjaIdsByCode.get(ninja.code) ?? null })),
    weekCompliance: summarizeWeekCompliance(currentRows.map((row) => row.status)),
    exemptionFlow: summarizeExemptionFlow(exemptionEntries, since),
    pointsDistributed: points._sum.points ?? 0
  };
}

export const eventKindLabels: Record<string, string> = { TOURNOI: "Tournoi", THEATRE: "Théâtre", JEU: "Jeu", AUTRE: "Autre" };

export async function getEvents(): Promise<EventsData> {
  if (demoMode) return demoEvents;
  const events = await prisma.event.findMany({ orderBy: { startsAt: "desc" }, take: 30, include: { winner: { select: { id: true, firstName: true, lastName: true } } } });
  const stateMap: Record<string, { label: string; badge: BadgeStatus }> = {
    PLANNED: { label: "À venir", badge: "pending" }, OPEN: { label: "En cours", badge: "due" },
    FINISHED: { label: "Terminé", badge: "paid" }, CANCELLED: { label: "Annulé", badge: "draft" }
  };
  return {
    metrics: {
      open: events.filter((event) => event.status === "OPEN" || event.status === "PLANNED").length,
      finished: events.filter((event) => event.status === "FINISHED").length,
      totalPrize: sumBig(events.filter((event) => event.status !== "CANCELLED").map((event) => event.prize)),
      participants: events.reduce((total, event) => total + event.participantCount, 0)
    },
    events: events.map((event) => {
      const state = stateMap[event.status] ?? { label: event.status, badge: "draft" as BadgeStatus };
      return {
        id: event.id, name: event.name, kindLabel: eventKindLabels[event.kind] ?? event.kind, statusLabel: state.label, badge: state.badge,
        period: `${formatDate(event.startsAt)}${event.endsAt ? ` — ${formatDate(event.endsAt)}` : ""}`, resourceFocus: event.resourceFocus,
        prize: event.prize, rewardPoints: event.rewardPoints, participants: event.participantCount,
        winnerId: event.winner?.id ?? null, winner: event.winner ? `${event.winner.firstName} ${event.winner.lastName}`.trim() : null, isOpen: event.status === "OPEN" || event.status === "PLANNED"
      };
    })
  };
}

export const reportStatusOptions = [
  { value: "DRAFT", label: "Brouillon", badge: "draft" },
  { value: "SUBMITTED", label: "Soumis", badge: "pending" },
  { value: "REVIEWED", label: "Examiné", badge: "warning" },
  { value: "RETURNED", label: "Renvoyé", badge: "overdue" },
  { value: "APPROVED", label: "Approuvé", badge: "paid" }
] as const satisfies ReadonlyArray<{ value: string; label: string; badge: BadgeStatus }>;

export interface ReportsFilterParams { auteur?: string | undefined; statut?: string | undefined; du?: string | undefined; au?: string | undefined }

export async function getReports(session: SessionInfo, page = 1, filters: ReportsFilterParams = {}): Promise<ReportsData> {
  if (demoMode) return demoReports;
  if (!hasPermission(session, "reports:read")) throw new Error("FORBIDDEN");
  const pageSize = 12;
  const requestedPage = Number.isSafeInteger(page) && page > 0 ? page : 1;
  const status = reportStatusOptions.find((option) => option.value === filters.statut)?.value;
  const { from, to } = normalizeReportHistoryRange(filters.du, filters.au);
  const canReadAll = hasPermission(session, "reports:read-all");
  const visibilityWhere: Prisma.AgentReportWhereInput = canReadAll
    ? { OR: [{ authorId: session.userId }, { status: { not: "DRAFT" } }] }
    : { authorId: session.userId };
  const filterWhere: Prisma.AgentReportWhereInput = {
    ...(filters.auteur ? { authorId: filters.auteur } : {}),
    ...(status ? { status } : {}),
    ...(from || to ? { periodStart: { ...(to ? { lte: to } : {}) }, periodEnd: { ...(from ? { gte: from } : {}) } } : {})
  };
  const where: Prisma.AgentReportWhereInput = { AND: [visibilityWhere, filterWhere] };
  const canReview = hasPermission(session, "reports:review");
  const canWrite = hasPermission(session, "reports:write");
  const total = await prisma.agentReport.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(requestedPage, pageCount);
  const [reports, toReview, approved, totals, reportAuthors, users] = await Promise.all([
    prisma.agentReport.findMany({ where, orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }], skip: (currentPage - 1) * pageSize, take: pageSize }),
    prisma.agentReport.count({ where: { AND: [where, { status: "SUBMITTED" }, ...(canReview ? [{ authorId: { not: session.userId } }] : [])] } }),
    prisma.agentReport.count({ where: { AND: [where, { status: "APPROVED" }] } }),
    prisma.agentReport.aggregate({ where, _sum: { paymentCount: true, donationCount: true, buybackCount: true, collectedAmount: true, processedValue: true, correctionCount: true } }),
    prisma.agentReport.findMany({ where: visibilityWhere, select: { authorId: true }, distinct: ["authorId"] }),
    getUserNames()
  ]);
  const statusLabelMap = new Map(reportStatusOptions.map((option) => [option.value, option]));
  return {
    metrics: {
      toReview,
      approved,
      covered: (totals._sum.paymentCount ?? 0) + (totals._sum.donationCount ?? 0) + (totals._sum.buybackCount ?? 0),
      processed: (totals._sum.collectedAmount ?? 0n) + (totals._sum.processedValue ?? 0n),
      corrections: totals._sum.correctionCount ?? 0
    },
    reports: reports.map((report) => {
      const state = statusLabelMap.get(report.status) ?? { label: report.status, badge: "draft" as BadgeStatus };
      return {
        id: report.id, period: `${formatDate(report.periodStart)} — ${formatDate(report.periodEnd)}`, agent: users.get(report.authorId) ?? "Agent Kōeki",
        payments: report.paymentCount, donationBuybacks: `${report.donationCount + report.buybackCount}`, processed: report.collectedAmount + report.processedValue,
        statusLabel: state.label, badge: state.badge, canReview: canReview && report.status === "SUBMITTED" && report.authorId !== session.userId,
        canEdit: canWrite && report.authorId === session.userId && (report.status === "DRAFT" || report.status === "RETURNED"),
        createdAt: formatDateTime(report.createdAt), summary: report.summary, incidents: report.incidents, stockIssues: report.stockIssues, followUps: report.followUps
      };
    }),
    authors: reportAuthors.map(({ authorId }) => ({ id: authorId, name: users.get(authorId) ?? "Agent Kōeki" })).sort((a, b) => a.name.localeCompare(b.name, "fr")),
    total, page: currentPage, pageCount
  };
}

/** Action-prefix families used to filter the audit log by theme. */
export const auditCategories: Record<string, { label: string; prefixes: string[] }> = {
  finances: { label: "Finances (paiements, dons, rachats, prix)", prefixes: ["PAYMENT", "BUYBACK", "DONATION", "PRICE"] },
  ninjas: { label: "Ninjas (dossiers, grades)", prefixes: ["NINJA", "GRADE"] },
  acces: { label: "Accès (invitations, comptes)", prefixes: ["INVITATION", "USER"] },
  stock: { label: "Stocks et catalogue", prefixes: ["INVENTORY", "RESOURCE", "CRAFT", "RECIPE"] },
  config: { label: "Configuration et événements", prefixes: ["PENALTY", "APPROVAL", "EVENT"] },
  rapports: { label: "Rapports", prefixes: ["REPORT"] },
  import: { label: "Imports de reprise", prefixes: ["LEGACY"] }
};

export interface AuditFilterParams { categorie?: string | undefined; q?: string | undefined; acteur?: string | undefined }

export async function getAudit(page: number, filters: AuditFilterParams = {}): Promise<AuditData> {
  if (demoMode) return demoAudit;
  const pageSize = 25;
  const conditions: Prisma.AuditLogWhereInput[] = [];
  const category = filters.categorie ? auditCategories[filters.categorie] : undefined;
  if (category) conditions.push({ OR: category.prefixes.map((prefix) => ({ action: { startsWith: prefix } })) });
  if (filters.q?.trim()) { const query = filters.q.trim(); conditions.push({ OR: [{ action: { contains: query, mode: "insensitive" } }, { entityId: { contains: query, mode: "insensitive" } }, { reason: { contains: query, mode: "insensitive" } }] }); }
  if (filters.acteur) conditions.push({ actorId: filters.acteur });
  const where: Prisma.AuditLogWhereInput = conditions.length ? { AND: conditions } : {};
  const [total, rows, actors, users] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (Math.max(1, page) - 1) * pageSize, take: pageSize }),
    prisma.user.findMany({ where: { auditLogs: { some: {} } }, select: { id: true }, orderBy: { name: "asc" } }),
    getUserNames()
  ]);
  return {
    rows: rows.map((row) => ({ id: row.id, at: formatDateTime(row.createdAt), actor: (row.actorId ? users.get(row.actorId) : null) ?? "Système", action: row.action, entity: `${row.entityType}·${row.entityId.slice(0, 10)}`, summary: row.reason ?? "—" })),
    actors: actors.map((actor) => ({ id: actor.id, name: users.get(actor.id) ?? "Sans nom" })).sort((a, b) => a.name.localeCompare(b.name)),
    total, page: Math.max(1, page), pageCount: Math.max(1, Math.ceil(total / pageSize))
  };
}

export async function getAdmin(): Promise<AdminData> {
  if (demoMode) return demoAdmin;
  const service = await getRpService();
  const currentRpYear = service.currentRpYear();
  const [penaltySetting, approvalSetting, exemptionSetting, rpSetting, policy, allGrades, invitations, users, roles, freeNinjas, activeNinjas, gradesToUpdate, currentYear] = await Promise.all([
    prisma.appSetting.findUnique({ where: { key: "latePenalty" } }),
    prisma.appSetting.findUnique({ where: { key: "approvalThreshold" } }),
    prisma.appSetting.findUnique({ where: { key: "exemptionPolicy" } }),
    prisma.appSetting.findUnique({ where: { key: "rpTime" } }),
    prisma.taxPolicy.findFirst({ where: { isActive: true }, include: { rates: true } }),
    prisma.ninjaGrade.findMany({ where: { isActive: true, code: { not: "UNKNOWN" } }, orderBy: { sortOrder: "asc" } }),
    prisma.invitation.findMany({ orderBy: { createdAt: "desc" }, take: 20, include: { role: true, ninjaProfile: { select: { code: true } } } }),
    prisma.user.findMany({ include: { roles: { include: { role: true } }, ninjaProfile: { select: { firstName: true, lastName: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.role.findMany(),
    prisma.ninjaProfile.findMany({ where: { userId: null, status: "ACTIVE" }, orderBy: { code: "asc" }, select: { id: true, code: true, firstName: true, lastName: true } }),
    prisma.ninjaProfile.count({ where: { status: "ACTIVE", currentGrade: { code: { not: "UNKNOWN" } } } }),
    prisma.ninjaProfile.count({ where: { status: "ACTIVE", currentGrade: { code: "UNKNOWN" } } }),
    prisma.taxYear.findUnique({ where: { rpYear: currentRpYear }, include: { _count: { select: { assessments: true } } } })
  ]);
  const [lines, billable] = currentYear ? await Promise.all([
    prisma.taxAssessment.count({ where: { taxYearId: currentYear.id, ninja: { status: "ACTIVE", currentGrade: { code: { not: "UNKNOWN" } } } } }),
    prisma.taxAssessment.count({ where: { taxYearId: currentYear.id, ninja: { status: "ACTIVE", currentGrade: { code: { not: "UNKNOWN" } } }, originalAmount: { gt: 0 } } })
  ]) : [0, 0];
  const penalty = penaltySetting?.value as { latePenaltyPercentBps?: number | null; latePenaltyBasis?: string; maxPenaltyApplications?: number; maxAssessmentDebt?: string; isPenaltyAutomationEnabled?: boolean; isRateValidated?: boolean } | undefined;
  const approval = approvalSetting?.value as { amount?: string; isValidated?: boolean } | undefined;
  const exemption = parseExemptionPolicy(exemptionSetting?.value);
  const rp = rpSetting ? rpTimeConfigSchema.safeParse(rpSetting.value) : null;
  const rpLabel = rp?.success ? `${Math.round(rp.data.realMillisecondsPerRpYear / 86_400_000)} jours réels = 1 année RP` : "1 semaine réelle = 1 année RP";
  const invitationStatus = (invitation: { status: string; expiresAt: Date }): { label: string; badge: BadgeStatus } =>
    invitation.status === "USED" ? { label: "Utilisée", badge: "paid" }
    : invitation.status === "REVOKED" ? { label: "Révoquée", badge: "overdue" }
    : invitation.expiresAt < new Date() ? { label: "Expirée", badge: "draft" } : { label: "En attente", badge: "pending" };
  const roleOrder: string[] = ["SUPER_ADMIN", "KOEKI_MANAGER", "ECONOMIC_AGENT", "AUDITOR", "NINJA"];
  return {
    penalty: {
      percentBps: penalty?.latePenaltyPercentBps ?? null, isValidated: penalty?.isRateValidated ?? false, isEnabled: penalty?.isPenaltyAutomationEnabled ?? false,
      basis: penalty?.latePenaltyBasis ?? "ORIGINAL_TAX", maxApplications: penalty?.maxPenaltyApplications ?? 4, maxDebt: penalty?.maxAssessmentDebt ?? "32000"
    },
    approval: { amount: approval?.amount ?? "50000", isValidated: approval?.isValidated ?? false },
    exemption: { weeklyTaxCoverageBps: exemption.weeklyTaxCoverageBps },
    gradeRates: allGrades.map((grade) => ({ gradeId: grade.id, label: grade.label, amount: Number(policy?.rates.find((rate) => rate.gradeId === grade.id)?.amount ?? 0n) })),
    currentWeek: { rpYear: currentRpYear, period: weekPeriod(service.dueAt(currentRpYear)), lines, billable, activeNinjas, gradesToUpdate },
    policy: policy ? { name: policy.name, version: policy.version, rateCount: policy.rates.length } : null,
    rpTimeLabel: rpLabel,
    invitations: invitations.map((invitation) => { const state = invitationStatus(invitation); return { id: invitation.id, role: roleLabels[invitation.role.code as keyof typeof roleLabels] ?? invitation.role.label, ninja: invitation.ninjaProfile?.code ?? null, statusLabel: state.label, badge: state.badge, createdAt: formatDate(invitation.createdAt), expiresAt: formatDate(invitation.expiresAt), canRevoke: invitation.status === "PENDING" }; }),
    users: users.map((user) => ({ id: user.id, name: user.ninjaProfile ? `${user.ninjaProfile.firstName} ${user.ninjaProfile.lastName}`.trim() : user.name ?? user.email ?? user.id, roles: user.roles.map((entry) => roleLabels[entry.role.code as keyof typeof roleLabels] ?? entry.role.label).join(", ") || "Sans rôle", roleCodes: user.roles.map((entry) => entry.role.code), revoked: user.revokedAt !== null })),
    roles: [...roles].sort((a, b) => roleOrder.indexOf(a.code) - roleOrder.indexOf(b.code)).map((role) => ({ id: role.id, code: role.code, label: roleLabels[role.code as keyof typeof roleLabels] ?? role.label })),
    freeNinjas: freeNinjas.map((ninja) => ({ id: ninja.id, code: ninja.code, name: `${ninja.firstName} ${ninja.lastName}` }))
  };
}
