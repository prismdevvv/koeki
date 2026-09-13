import { Prisma, prisma, type PointEventType, type TaxAssessmentStatus } from "@koeki/database";
import {
  calculatePoints, createRpTimeService, defaultRpTimeConfig, deriveTaxAssessmentStatus,
  EXEMPTION_POLICY_SETTING_KEY, exemptionUse, parseExemptionPolicy, rpTimeConfigSchema
} from "@koeki/domain";
import type { SessionInfo } from "@/lib/session";

export type Tx = Prisma.TransactionClient;

export async function loadExemptionPolicy(tx: Tx) {
  // Every credit consumer locks NinjaProfile first, then retains this shared
  // setting lock until commit. An administrative switch to 0 therefore waits
  // for older consumers and no old-rate debit can commit after that switch.
  const rows = await tx.$queryRaw<Array<{ value: Prisma.JsonValue }>>`
    SELECT "value" FROM "AppSetting"
    WHERE "key" = ${EXEMPTION_POLICY_SETTING_KEY}
    FOR SHARE
  `;
  return parseExemptionPolicy(rows[0]?.value);
}

const DECIMAL_SCALE = 10_000;
const POSTGRES_INT_MIN = -2_147_483_648;
const POSTGRES_INT_MAX = 2_147_483_647;

/** Parses a user-entered quantity without silently rounding beyond Decimal(20,4). */
export function parseFourDecimal(raw: string): number | null {
  const normalized = raw.trim().replace(",", ".");
  if (!/^[+-]?(?:\d+(?:\.\d{1,4})?|\.\d{1,4})$/.test(normalized)) return null;
  const value = Number(normalized);
  const scaled = Math.round(value * DECIMAL_SCALE);
  if (!Number.isFinite(value) || !Number.isSafeInteger(scaled)) return null;
  return scaled / DECIMAL_SCALE;
}

function scaledQuantity(quantity: number): bigint {
  const rawScaled = quantity * DECIMAL_SCALE;
  const scaled = Math.round(rawScaled);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(rawScaled)) * 4;
  if (!Number.isFinite(quantity) || !Number.isSafeInteger(scaled) || Math.abs(rawScaled - scaled) > tolerance || (quantity !== 0 && scaled === 0)) {
    throw new Error("VALIDATION:Quantité invalide — 4 décimales maximum");
  }
  return BigInt(scaled);
}

/** Serialises stock-sensitive mutations. IDs are sorted so multi-resource commands
 * always acquire locks in the same order and cannot deadlock one another. */
export async function lockResources(tx: Tx, resourceIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(resourceIds)].sort();
  if (!ids.length) return new Set();
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Resource"
    WHERE "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR UPDATE
  `;
  return new Set(rows.map((row) => row.id));
}

/** Locks a ninja lifecycle row and confirms it is still eligible for a mutation. */
export async function lockActiveNinja(tx: Tx, ninjaId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT "status"
    FROM "NinjaProfile"
    WHERE "id" = ${ninjaId}
    FOR UPDATE
  `;
  return rows[0]?.status === "ACTIVE";
}

export async function writeAudit(tx: Tx, entry: { actorId: string | null; action: string; entityType: string; entityId: string; reason?: string | undefined; previousValues?: Prisma.InputJsonValue | undefined; newValues?: Prisma.InputJsonValue | undefined }) {
  await tx.auditLog.create({ data: {
    actorId: entry.actorId, action: entry.action, entityType: entry.entityType, entityId: entry.entityId, requestId: crypto.randomUUID(),
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    ...(entry.previousValues !== undefined ? { previousValues: entry.previousValues } : {}),
    ...(entry.newValues !== undefined ? { newValues: entry.newValues } : {})
  } });
}

export async function nextPaymentReceipt(tx: Tx) {
  const year = new Date().getFullYear();
  const count = await tx.taxPayment.count({ where: { receiptNumber: { startsWith: `PAY-${year}-` } } });
  return `PAY-${year}-${String(count + 1).padStart(6, "0")}`;
}

export async function nextTransactionReceipt(tx: Tx, type: "DONATION" | "BUYBACK") {
  const prefix = type === "BUYBACK" ? "BUY" : "DON";
  const year = new Date().getFullYear();
  const count = await tx.resourceTransaction.count({ where: { receiptNumber: { startsWith: `${prefix}-${year}-` } } });
  return `${prefix}-${year}-${String(count + 1).padStart(6, "0")}`;
}

/** Multiplies a decimal quantity (4-digit precision) by an integer bigint rate, flooring the result. */
export const scaledTimes = (quantity: number, rate: bigint) => (scaledQuantity(quantity) * rate) / BigInt(DECIMAL_SCALE);

export async function activePrice(tx: Tx, resourceId: string) {
  const price = await tx.resourcePriceHistory.findFirst({ where: { resourceId, effectiveFrom: { lte: new Date() }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }] }, orderBy: { effectiveFrom: "desc" } });
  return price?.pricePerUnit ?? null;
}

/** Applies the side effects of a VALIDATED resource transaction: stock movements, points
 *  (per-unit scale plus any active rule for donations, rules only for buybacks) and
 *  tax-exemption credit, whose use on open taxes follows the administrative ceiling. Shared by
 *  agent-recorded flows and ninja self-declarations. */
export async function applyValidatedTransaction(tx: Tx, transaction: { id: string; type: "DONATION" | "BUYBACK"; ninjaId: string; receiptNumber: string; totalAmount: bigint; idempotencyKey: string }, items: Array<{ resourceId: string; quantity: number; unitPrice: bigint; exemptionPerUnit: bigint; pointsPerUnit: number }>, actorId: string) {
  for (const item of items) await tx.inventoryMovement.create({ data: {
    resourceId: item.resourceId, type: transaction.type === "BUYBACK" ? "BUYBACK_IN" : "DONATION_IN", quantity: new Prisma.Decimal(item.quantity),
    unitCost: item.unitPrice, transactionId: transaction.id, agentId: actorId, justification: `Reçu ${transaction.receiptNumber}`, idempotencyKey: `${transaction.idempotencyKey}:${item.resourceId}`
  } });
  // Old-register scale: a donation earns each resource's own points per donated unit.
  const basePoints = transaction.type === "DONATION" ? items.reduce((total, item) => total + Number(scaledTimes(item.quantity, BigInt(item.pointsPerUnit))), 0) : 0;
  const points = await awardPoints(tx, { ninjaId: transaction.ninjaId, eventType: transaction.type === "BUYBACK" ? "RESOURCE_SALE" : "DONATION", amount: transaction.totalAmount, sourceType: "ResourceTransaction", sourceId: transaction.id, basePoints });
  if (points > 0) await tx.resourceTransaction.update({ where: { id: transaction.id }, data: { totalPoints: points } });
  // Old-register economy: giving resources earns tax-exemption credit, never direct Ryo.
  // Donations use each resource's per-unit exemption rate; buybacks credit the buyback price.
  const exemption = transaction.type === "BUYBACK" ? transaction.totalAmount : items.reduce((total, item) => total + scaledTimes(item.quantity, item.exemptionPerUnit), 0n);
  await grantExemption(tx, { ninjaId: transaction.ninjaId, amount: exemption, sourceType: "ResourceTransaction", sourceId: transaction.id, reason: `${transaction.type === "BUYBACK" ? "Rachat" : "Don"} ${transaction.receiptNumber}` });
  const covered = await autoCoverOpenTaxes(tx, transaction.ninjaId, actorId, transaction.idempotencyKey);
  return { points, exemption, covered };
}

/** Applies the allowed share of the ninja's credit to open taxes, oldest week first.
 * At 0 %, credit is retained without any tax write. The first application uses the plain
 *  assessment id as ledger source (the weekly job's idempotency check relies on it);
 *  top-ups on a partially covered week get a suffixed source so the unique constraint
 *  never blocks completing it. */
export async function autoCoverOpenTaxes(tx: Tx, ninjaId: string, grantedById: string, sourceKey: string): Promise<bigint> {
  // All credit spenders take the same lifecycle lock before reading the wallet.
  // Besides blocking post-mortem coverage, this serialises concurrent donations
  // and establishes the global Ninja -> AppSetting lock order.
  if (!await lockActiveNinja(tx, ninjaId)) return 0n;
  const policy = await loadExemptionPolicy(tx);
  if (policy.weeklyTaxCoverageBps <= 0) return 0n;
  let balance = await exemptionBalance(tx, ninjaId);
  if (balance <= 0n) return 0n;
  const rpSetting = await tx.appSetting.findUnique({ where: { key: "rpTime" } });
  const rpParsed = rpSetting ? rpTimeConfigSchema.safeParse(rpSetting.value) : null;
  const currentRpYear = createRpTimeService(rpParsed?.success ? rpParsed.data : defaultRpTimeConfig).currentRpYear();
  const open = await tx.taxAssessment.findMany({
    where: { ninjaId, originalAmount: { gt: 0 }, status: { in: ["UPCOMING", "DUE", "PARTIALLY_PAID", "OVERDUE"] } },
    include: { penalties: { select: { amount: true } }, adjustments: { select: { amount: true } }, exemptions: { select: { amount: true } }, allocations: { select: { amount: true, payment: { select: { status: true } } } } },
    orderBy: { dueAt: "asc" }
  });
  const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);
  let used = 0n;
  for (const assessment of open) {
    if (balance <= 0n) break;
    const paid = sum(assessment.allocations.filter((entry) => entry.payment.status === "VALIDATED").map((entry) => entry.amount));
    const gross = assessment.originalAmount + sum(assessment.penalties.map((entry) => entry.amount)) + sum(assessment.adjustments.map((entry) => entry.amount));
    const alreadyExempted = sum(assessment.exemptions.map((entry) => entry.amount));
    const remaining = gross - alreadyExempted - paid;
    if (remaining <= 0n) continue;
    const use = exemptionUse({ availableCredit: balance, remainingDebt: remaining, gross, alreadyExempted, coverageBps: policy.weeklyTaxCoverageBps });
    if (use <= 0n) continue;
    const first = await tx.exemptionLedgerEntry.findUnique({ where: { sourceType_sourceId: { sourceType: "TaxAssessment", sourceId: assessment.id } } });
    await tx.exemptionLedgerEntry.create({ data: { ninjaId, amount: -use, sourceType: "TaxAssessment", sourceId: first ? `${assessment.id}:${sourceKey}` : assessment.id, reason: "Exonération automatique (crédit de dons/rachats)" } });
    await tx.taxExemption.create({ data: { assessmentId: assessment.id, amount: use, reason: "Exonération automatique (crédit de dons/rachats)", grantedById } });
    await writeAudit(tx, { actorId: grantedById, action: "TAX_AUTO_EXEMPTED", entityType: "TaxAssessment", entityId: assessment.id, reason: `${use.toLocaleString("fr-FR")} ¥ de crédit appliqués (plafond ${(policy.weeklyTaxCoverageBps / 100).toLocaleString("fr-FR")} %)` });
    balance -= use;
    used += use;
    await refreshAssessmentStatus(tx, assessment.id, currentRpYear);
  }
  return used;
}

/** Aggregates the per-unit base points and every active matching rule into a single ledger entry per (source, eventType) — the unique constraint makes double grants impossible. */
export async function awardPoints(tx: Tx, input: { ninjaId: string; eventType: PointEventType; amount: bigint; sourceType: string; sourceId: string; basePoints?: number | undefined; reason?: string | undefined }) {
  const now = new Date();
  const rules = await tx.pointRule.findMany({ where: { eventType: input.eventType, isActive: true, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] } });
  let total = input.basePoints ?? 0;
  for (const rule of rules) total += calculatePoints({
    mode: rule.mode, fixedPoints: rule.fixedPoints ?? undefined, amount: input.amount, amountStep: rule.amountStep ?? undefined, pointsPerStep: rule.pointsPerStep ?? undefined,
    percentageBps: rule.mode === "PERCENTAGE" ? rule.multiplierBps ?? 0 : undefined, multiplier: rule.mode === "MULTIPLIER" ? (rule.multiplierBps ?? 10_000) / 10_000 : undefined,
    min: rule.minimum ?? undefined, max: rule.maximum ?? undefined
  });
  if (total === 0) return 0;
  if (!Number.isSafeInteger(total) || total < POSTGRES_INT_MIN || total > POSTGRES_INT_MAX) {
    throw new Error(`VALIDATION:Total de points hors limites (${POSTGRES_INT_MIN.toLocaleString("fr-FR")} à ${POSTGRES_INT_MAX.toLocaleString("fr-FR")})`);
  }
  const existing = await tx.pointLedgerEntry.findUnique({ where: { sourceType_sourceId_eventType: { sourceType: input.sourceType, sourceId: input.sourceId, eventType: input.eventType } } });
  if (existing) return 0;
  await tx.pointLedgerEntry.create({ data: { ninjaId: input.ninjaId, ruleId: rules[0]?.id ?? null, eventType: input.eventType, points: total, sourceType: input.sourceType, sourceId: input.sourceId, ...(input.reason !== undefined ? { reason: input.reason } : {}) } });
  return total;
}

/** Grants (or debits, with a negative amount) tax-exemption credit; unique per source. */
export async function grantExemption(tx: Tx, input: { ninjaId: string; amount: bigint; sourceType: string; sourceId: string; reason?: string | undefined }) {
  if (input.amount === 0n) return;
  const existing = await tx.exemptionLedgerEntry.findUnique({ where: { sourceType_sourceId: { sourceType: input.sourceType, sourceId: input.sourceId } } });
  if (existing) return;
  await tx.exemptionLedgerEntry.create({ data: { ninjaId: input.ninjaId, amount: input.amount, sourceType: input.sourceType, sourceId: input.sourceId, ...(input.reason !== undefined ? { reason: input.reason } : {}) } });
}

export async function exemptionBalance(tx: Tx, ninjaId: string): Promise<bigint> {
  const aggregate = await tx.exemptionLedgerEntry.aggregate({ where: { ninjaId }, _sum: { amount: true } });
  return aggregate._sum.amount ?? 0n;
}

/** Recomputes an assessment's stored status from its immutable ledger lines. */
export async function refreshAssessmentStatus(tx: Tx, assessmentId: string, currentRpYear: number) {
  const assessment = await tx.taxAssessment.findUniqueOrThrow({
    where: { id: assessmentId },
    include: { penalties: { select: { amount: true } }, adjustments: { select: { amount: true } }, exemptions: { select: { amount: true } }, allocations: { select: { amount: true, payment: { select: { status: true } } } }, taxYear: { select: { rpYear: true } } }
  });
  const frozen: TaxAssessmentStatus[] = ["EXEMPT", "WAIVED", "SUSPENDED", "CANCELLED", "DRAFT"];
  if (frozen.includes(assessment.status)) return assessment.status;
  const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);
  const paid = sum(assessment.allocations.filter((entry) => entry.payment.status === "VALIDATED").map((entry) => entry.amount));
  const penalties = sum(assessment.penalties.map((entry) => entry.amount));
  const adjustments = sum(assessment.adjustments.map((entry) => entry.amount));
  const exempted = sum(assessment.exemptions.map((entry) => entry.amount));
  const gross = assessment.originalAmount + penalties + adjustments - exempted;
  const remaining = gross - paid > 0n ? gross - paid : 0n;
  const preserveLegacyOverdue = assessment.status === "OVERDUE" && assessment.gradeCodeSnapshot === "ANCIEN" && assessment.originalAmount === 0n
    && penalties === 0n && adjustments === 0n && exempted === 0n && paid === 0n;
  const now = new Date();
  const status = deriveTaxAssessmentStatus({
    storedStatus: assessment.status,
    remaining,
    settled: paid + exempted,
    preserveLegacyOverdue,
    dueAt: assessment.dueAt,
    now,
    assessmentRpYear: assessment.taxYear.rpYear,
    currentRpYear
  }) as TaxAssessmentStatus;
  if (status !== assessment.status) await tx.taxAssessment.update({ where: { id: assessmentId }, data: { status, version: { increment: 1 } } });
  return status;
}

export function isUniqueViolation(error: unknown) { return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"; }

/** Names of the columns that violated a unique constraint — distinguishes a receipt-number collision (retryable) from an idempotency replay (duplicate). */
export function uniqueViolationTarget(error: unknown): string {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return "";
  const target = (error.meta as { target?: string[] | string } | undefined)?.target;
  return Array.isArray(target) ? target.join(",") : String(target ?? "");
}

/** Retries a transaction when two concurrent writes computed the same receipt number. */
export async function withReceiptRetry<T>(run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await run(); }
    catch (error) { if (uniqueViolationTarget(error).includes("receiptNumber")) { lastError = error; continue; } throw error; }
  }
  throw lastError;
}

export const MAX_TRANSACTION_UNIT_PRICE = 100_000_000;
export const canApproveBuybacks = (roles: readonly string[]) => roles.some((role) => role === "SUPER_ADMIN" || role === "KOEKI_MANAGER");

export type TransactionLine = { resourceId: string; quantity: number; negotiated: bigint | null };

/** Reads the resourceId_N / quantity_N / unitPrice_N fields shared by every
 * donation/buyback form (whole-catalog picker or a ninja fiche's own donation
 * panel). Returns a validation message instead of throwing so each caller can
 * redirect back to its own page with the right query string. */
export function parseTransactionLines(formData: FormData, type: "DONATION" | "BUYBACK", maxLines = 8): { lines: TransactionLine[] } | { error: string } {
  const lines: TransactionLine[] = [];
  for (let index = 1; index <= maxLines; index++) {
    const resourceId = formData.get(`resourceId_${index}`);
    const quantityRaw = formData.get(`quantity_${index}`);
    if (typeof resourceId === "string" && resourceId && typeof quantityRaw === "string" && quantityRaw) {
      const quantity = parseFourDecimal(quantityRaw);
      if (quantity === null) return { error: `Quantité invalide sur la ligne ${index} (4 décimales maximum)` };
      if (quantity <= 0 || quantity > 1_000_000) return { error: `Quantité invalide sur la ligne ${index} (entre 0,0001 et 1 000 000)` };
      if (lines.some((line) => line.resourceId === resourceId)) return { error: "Une même ressource apparaît deux fois" };
      // Buyback price is negotiable downwards: the agent may enter a unit price below the catalog maximum.
      let negotiated: bigint | null = null;
      const priceRaw = formData.get(`unitPrice_${index}`);
      if (type === "BUYBACK" && typeof priceRaw === "string" && priceRaw !== "") {
        const price = Number(priceRaw);
        if (!Number.isSafeInteger(price) || price < 1 || price > MAX_TRANSACTION_UNIT_PRICE) return { error: `Prix négocié invalide sur la ligne ${index} (entier en Ryō, de 1 à ${MAX_TRANSACTION_UNIT_PRICE.toLocaleString("fr-FR")})` };
        negotiated = BigInt(price);
      }
      lines.push({ resourceId, quantity, negotiated });
    }
  }
  if (!lines.length) return { error: "Ajoutez au moins une ressource — tapez son nom puis choisissez une proposition de la liste" };
  return { lines };
}

/** Core of every donation/buyback write — shared by the whole-catalog picker
 * (which resolves ninjaId from a Zenkai character first) and a ninja fiche's
 * own donation panel (where ninjaId is already known). */
export async function executeResourceTransaction(session: SessionInfo, ninjaId: string, type: "DONATION" | "BUYBACK", lines: TransactionLine[], idempotencyKey: string): Promise<string> {
  return withReceiptRetry(() => prisma.$transaction(async (tx) => {
    if (!await lockActiveNinja(tx, ninjaId)) throw new Error("VALIDATION:Ninja introuvable ou dossier inactif");
    const items: Array<{ resourceId: string; quantity: number; unitPrice: bigint; lineTotal: bigint; exemptionPerUnit: bigint; pointsPerUnit: number }> = [];
    for (const line of lines) {
      const resource = await tx.resource.findUnique({ where: { id: line.resourceId } });
      if (!resource || !resource.isActive) throw new Error("VALIDATION:Ressource inconnue ou inactive");
      const price = await activePrice(tx, line.resourceId);
      if (type === "BUYBACK" && (price === null || price <= 0n)) throw new Error(`VALIDATION:Aucun prix actif pour ${resource.name} — configurez-le avant tout rachat`);
      if (type === "BUYBACK" && line.negotiated !== null && price !== null && line.negotiated > price) throw new Error(`VALIDATION:Prix négocié au-dessus du catalogue pour ${resource.name} (maximum ${Number(price).toLocaleString("fr-FR")} ¥/u)`);
      const unitPrice = type === "BUYBACK" && line.negotiated !== null ? line.negotiated : price ?? 0n;
      items.push({ resourceId: line.resourceId, quantity: line.quantity, unitPrice, lineTotal: scaledTimes(line.quantity, unitPrice), exemptionPerUnit: resource.exemptionPerUnit, pointsPerUnit: resource.pointsPerUnit });
    }
    const totalAmount = items.reduce((total, item) => total + item.lineTotal, 0n);
    const approvalSetting = await tx.appSetting.findUnique({ where: { key: "approvalThreshold" } });
    const approval = approvalSetting?.value as { amount?: string; isValidated?: boolean } | undefined;
    const needsApproval = type === "BUYBACK" && approval?.isValidated === true && totalAmount > BigInt(approval.amount ?? "50000") && !canApproveBuybacks(session.roles);
    const receiptNumber = await nextTransactionReceipt(tx, type);
    const transaction = await tx.resourceTransaction.create({ data: {
      receiptNumber, type, status: needsApproval ? "PENDING_APPROVAL" : "VALIDATED", ninjaId, agentId: session.userId, totalAmount, idempotencyKey, validatedAt: needsApproval ? null : new Date()
    } });
    await tx.resourceTransactionItem.createMany({ data: items.map((item) => ({ transactionId: transaction.id, resourceId: item.resourceId, quantity: new Prisma.Decimal(item.quantity), unitPriceSnapshot: item.unitPrice, lineTotal: item.lineTotal })) });
    if (!needsApproval) await applyValidatedTransaction(tx, { id: transaction.id, type, ninjaId, receiptNumber, totalAmount, idempotencyKey }, items, session.userId);
    await writeAudit(tx, { actorId: session.userId, action: type === "BUYBACK" ? (needsApproval ? "BUYBACK_PENDING_APPROVAL" : "BUYBACK_RECORDED") : "DONATION_RECORDED", entityType: "ResourceTransaction", entityId: transaction.id, reason: `${type === "BUYBACK" ? "Rachat" : "Don"} ${receiptNumber} — ${Number(totalAmount).toLocaleString("fr-FR")} Ryō`, newValues: { items: items.map((item) => ({ resourceId: item.resourceId, quantity: item.quantity, unitPrice: Number(item.unitPrice) })) } });
    return receiptNumber;
  }));
}
