"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { Prisma, prisma } from "@koeki/database";
import { activePrice, applyValidatedTransaction, isUniqueViolation, lockActiveNinja, lockResources, nextTransactionReceipt, parseFourDecimal, scaledTimes, withReceiptRetry, writeAudit } from "@/lib/finance";
import { findOrCreateNinjaProfileForCharacter } from "@/lib/ninja-link";
import { requireWriteAccess } from "@/lib/session";
import { getRecentlyActiveSunaCharacters } from "@/lib/zenkai";

const MAX_UNIT_PRICE = 100_000_000;
const canApproveBuybacks = (roles: readonly string[]) => roles.some((role) => role === "SUPER_ADMIN" || role === "KOEKI_MANAGER");

const transactionSchema = z.object({
  type: z.enum(["DONATION", "BUYBACK"]),
  zenkaiCharKey: z.string().min(1, "Sélectionnez un ninja"),
  idempotencyKey: z.string().uuid()
});

export async function recordResourceTransaction(formData: FormData) {
  const session = await requireWriteAccess("inventory:write");
  const parsed = transactionSchema.safeParse({ type: formData.get("type"), zenkaiCharKey: formData.get("zenkaiCharKey"), idempotencyKey: formData.get("idempotencyKey") });
  const back = (message: string): never => redirect(`/resources/transaction?erreur=${encodeURIComponent(message)}`);
  if (!parsed.success) back(parsed.error.issues[0]?.message ?? "Saisie invalide");
  const { type, zenkaiCharKey, idempotencyKey } = parsed.data!;
  // The picker searches Zenkai's live roster directly — resolve (or silently create) the
  // matching fiche before touching the ledger, so no manual "fiche" step is ever required.
  const character = (await getRecentlyActiveSunaCharacters()).find((entry) => entry.charKey === zenkaiCharKey);
  if (!character) back("Ce ninja n’est plus dans la liste des personnages actifs — rafraîchissez la page");
  const ninjaId = await findOrCreateNinjaProfileForCharacter(session.userId, character!).catch((error) => {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) back(error.message.slice("VALIDATION:".length));
    throw error;
  });
  const lines: Array<{ resourceId: string; quantity: number; negotiated: bigint | null }> = [];
  for (let index = 1; index <= 8; index++) {
    const resourceId = formData.get(`resourceId_${index}`);
    const quantityRaw = formData.get(`quantity_${index}`);
    if (typeof resourceId === "string" && resourceId && typeof quantityRaw === "string" && quantityRaw) {
      const quantity = parseFourDecimal(quantityRaw) ?? back(`Quantité invalide sur la ligne ${index} (4 décimales maximum)`);
      if (quantity <= 0 || quantity > 1_000_000) back(`Quantité invalide sur la ligne ${index} (entre 0,0001 et 1 000 000)`);
      if (lines.some((line) => line.resourceId === resourceId)) back("Une même ressource apparaît deux fois");
      // Buyback price is negotiable downwards: the agent may enter a unit price below the catalog maximum.
      let negotiated: bigint | null = null;
      const priceRaw = formData.get(`unitPrice_${index}`);
      if (type === "BUYBACK" && typeof priceRaw === "string" && priceRaw !== "") {
        const price = Number(priceRaw);
        if (!Number.isSafeInteger(price) || price < 1 || price > MAX_UNIT_PRICE) back(`Prix négocié invalide sur la ligne ${index} (entier en Ryō, de 1 à ${MAX_UNIT_PRICE.toLocaleString("fr-FR")})`);
        negotiated = BigInt(price);
      }
      lines.push({ resourceId, quantity, negotiated });
    }
  }
  if (!lines.length) back("Ajoutez au moins une ressource — tapez son nom puis choisissez une proposition de la liste");
  let receipt = "";
  try {
    receipt = await withReceiptRetry(() => prisma.$transaction(async (tx) => {
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
      await writeAudit(tx, { actorId: session.userId, action: type === "BUYBACK" ? (needsApproval ? "BUYBACK_PENDING_APPROVAL" : "BUYBACK_RECORDED") : "DONATION_RECORDED", entityType: "ResourceTransaction", entityId: transaction.id, reason: `${type === "BUYBACK" ? "Rachat" : "Don"} ${receiptNumber} — ${Number(totalAmount)} Ryō`, newValues: { items: items.map((item) => ({ resourceId: item.resourceId, quantity: item.quantity, unitPrice: Number(item.unitPrice) })) } });
      return receiptNumber;
    }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) back(error.message.slice("VALIDATION:".length));
    if (isUniqueViolation(error)) back("Cette transaction a déjà été enregistrée (double soumission détectée)");
    throw error;
  }
  redirect(`/resources?recu=${encodeURIComponent(receipt)}`);
}

export async function approveTransaction(formData: FormData) {
  const session = await requireWriteAccess("settings:manage");
  if (!canApproveBuybacks(session.roles)) redirect("/resources?erreur=Validation%20r%C3%A9serv%C3%A9e%20aux%20responsables");
  const transactionId = formData.get("transactionId");
  if (typeof transactionId !== "string" || !transactionId) redirect("/resources");
  try {
    await prisma.$transaction(async (tx) => {
      const transaction = await tx.resourceTransaction.findUnique({ where: { id: transactionId }, include: { items: { include: { resource: { select: { exemptionPerUnit: true, pointsPerUnit: true, isActive: true } } } } } });
      if (!transaction || transaction.type !== "BUYBACK" || transaction.status !== "PENDING_APPROVAL") throw new Error("VALIDATION:Rachat déjà traité ou introuvable");
      if (!await lockActiveNinja(tx, transaction.ninjaId)) throw new Error("VALIDATION:Le dossier ninja n’est plus actif");
      if (transaction.items.some((item) => !item.resource.isActive)) throw new Error("VALIDATION:Une ressource du rachat est devenue inactive");
      const approved = await tx.resourceTransaction.updateMany({
        where: { id: transactionId, type: "BUYBACK", status: "PENDING_APPROVAL" },
        data: { status: "VALIDATED", validatedAt: new Date() }
      });
      if (approved.count !== 1) throw new Error("VALIDATION:Rachat déjà traité");
      await applyValidatedTransaction(tx, { id: transaction.id, type: transaction.type, ninjaId: transaction.ninjaId, receiptNumber: transaction.receiptNumber, totalAmount: transaction.totalAmount, idempotencyKey: transaction.idempotencyKey }, transaction.items.map((item) => ({ resourceId: item.resourceId, quantity: Number(item.quantity), unitPrice: item.unitPriceSnapshot, exemptionPerUnit: item.resource.exemptionPerUnit, pointsPerUnit: item.resource.pointsPerUnit })), transaction.agentId);
      await writeAudit(tx, { actorId: session.userId, action: "BUYBACK_APPROVED", entityType: "ResourceTransaction", entityId: transactionId, reason: `Validation managériale du reçu ${transaction.receiptNumber}` });
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) redirect(`/resources?erreur=${encodeURIComponent(error.message.slice("VALIDATION:".length))}`);
    if (isUniqueViolation(error)) redirect("/resources?erreur=Mouvements%20d%C3%A9j%C3%A0%20appliqu%C3%A9s");
    throw error;
  }
  redirect("/resources");
}

const stockLevelSchema = z.preprocess(
  (value) => value === undefined || value === null || value === "" ? "0" : typeof value === "number" ? String(value) : value,
  z.string().trim()
    .refine((value) => parseFourDecimal(value) !== null, "Quantité invalide (4 décimales maximum)")
    .transform((value) => parseFourDecimal(value)!)
    .pipe(z.number().min(0).max(1_000_000_000))
);

const resourceSchema = z.object({
  name: z.string().trim().min(2, "Le nom est obligatoire").max(120),
  categoryId: z.string().min(1, "La catégorie est obligatoire"),
  description: z.string().trim().max(500).optional().transform((value) => value || null),
  minimumStock: stockLevelSchema,
  criticalStock: stockLevelSchema,
  demand: z.enum(["NONE", "NEEDED", "CRITICAL"]).default("NONE"),
  pointsPerUnit: z.coerce.number().int("Points invalides (entier)").min(0).max(1_000_000).default(0),
  exemptionPerUnit: z.coerce.number().int("Exonération invalide (entier en Ryō)").min(0).max(100_000_000_000).default(0)
});

const codeBase = (name: string) => name.normalize("NFD").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "X");

export async function createResource(formData: FormData) {
  const session = await requireWriteAccess("settings:manage");
  const back = (message: string): never => redirect(`/resources/new?erreur=${encodeURIComponent(message)}`);
  const parsed = resourceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) back(parsed.error.issues[0]?.message ?? "Saisie invalide");
  const priceRaw = formData.get("price");
  const price = typeof priceRaw === "string" && priceRaw !== "" ? Number(priceRaw) : null;
  if (price !== null && (!Number.isSafeInteger(price) || price < 0 || price > MAX_UNIT_PRICE)) back(`Prix invalide (entier en Ryō, maximum ${MAX_UNIT_PRICE.toLocaleString("fr-FR")})`);
  const data = parsed.data!;
  if (data.criticalStock > data.minimumStock) back("Le seuil critique doit être inférieur ou égal au seuil bas");
  const base = codeBase(data.name);
  let created = false;
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    const count = await prisma.resource.count({ where: { code: { startsWith: `RES-${base}-` } } });
    const code = `RES-${base}-${String(count + 1 + attempt).padStart(2, "0")}`;
    try {
      await prisma.$transaction(async (tx) => {
        const resource = await tx.resource.create({ data: { code, name: data.name, categoryId: data.categoryId, description: data.description, demand: data.demand, minimumStock: new Prisma.Decimal(data.minimumStock), criticalStock: new Prisma.Decimal(data.criticalStock), pointsPerUnit: data.pointsPerUnit, exemptionPerUnit: BigInt(data.exemptionPerUnit) } });
        if (price !== null && price > 0) await tx.resourcePriceHistory.create({ data: { resourceId: resource.id, pricePerUnit: BigInt(price), effectiveFrom: new Date(), createdById: session.userId } });
        await writeAudit(tx, { actorId: session.userId, action: "RESOURCE_CREATED", entityType: "Resource", entityId: resource.id, newValues: { code, name: data.name, price, pointsPerUnit: data.pointsPerUnit, exemptionPerUnit: data.exemptionPerUnit } });
      });
      created = true;
    } catch (error) { if (!isUniqueViolation(error)) throw error; }
  }
  if (!created) back("Conflit de code, réessayez");
  redirect("/resources");
}

const updateResourceSchema = resourceSchema.extend({
  resourceId: z.string().min(1),
  isActive: z.literal("on").optional(),
  price: z.preprocess((value) => (value === null || value === "" ? undefined : value), z.coerce.number().int("Prix invalide (entier en Ryō)").min(0, "Prix invalide").max(MAX_UNIT_PRICE, `Prix maximum : ${MAX_UNIT_PRICE.toLocaleString("fr-FR")} Ryō`).optional()),
  priceReason: z.string().trim().max(300).optional()
});

export async function updateResource(formData: FormData) {
  const session = await requireWriteAccess("settings:manage");
  const parsed = updateResourceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`/resources?erreur=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Saisie invalide")}`);
  const { resourceId, isActive, price, priceReason, ...data } = parsed.data!;
  const back = (message: string): never => redirect(`/resources/${resourceId}/modifier?erreur=${encodeURIComponent(message)}`);
  if (data.criticalStock > data.minimumStock) back("Le seuil critique doit être inférieur ou égal au seuil bas");
  const previous = await prisma.resource.findUnique({ where: { id: resourceId } });
  if (!previous) redirect("/resources?erreur=Ressource%20introuvable");
  try {
    await prisma.$transaction(async (tx) => {
      await tx.resource.update({ where: { id: resourceId }, data: { name: data.name, categoryId: data.categoryId, description: data.description, demand: data.demand, minimumStock: new Prisma.Decimal(data.minimumStock), criticalStock: new Prisma.Decimal(data.criticalStock), pointsPerUnit: data.pointsPerUnit, exemptionPerUnit: BigInt(data.exemptionPerUnit), isActive: isActive === "on" } });
      await writeAudit(tx, { actorId: session.userId, action: "RESOURCE_UPDATED", entityType: "Resource", entityId: resourceId,
        previousValues: { name: previous!.name, minimumStock: Number(previous!.minimumStock), criticalStock: Number(previous!.criticalStock), pointsPerUnit: previous!.pointsPerUnit, exemptionPerUnit: Number(previous!.exemptionPerUnit), isActive: previous!.isActive },
        newValues: { name: data.name, minimumStock: data.minimumStock, criticalStock: data.criticalStock, pointsPerUnit: data.pointsPerUnit, exemptionPerUnit: data.exemptionPerUnit, isActive: isActive === "on" } });
      if (price !== undefined) {
        const current = await activePrice(tx, resourceId);
        const changed = current === null ? price > 0 : BigInt(price) !== current;
        if (changed) {
          if (!priceReason || priceReason.length < 3) throw new Error("VALIDATION:Un motif d’au moins 3 caractères est obligatoire pour changer le prix");
          const now = new Date();
          await tx.resourcePriceHistory.updateMany({ where: { resourceId, effectiveTo: null }, data: { effectiveTo: now } });
          await tx.resourcePriceHistory.create({ data: { resourceId, pricePerUnit: BigInt(price), effectiveFrom: now, createdById: session.userId } });
          await writeAudit(tx, { actorId: session.userId, action: "PRICE_UPDATED", entityType: "Resource", entityId: resourceId, reason: priceReason, previousValues: { pricePerUnit: current === null ? null : Number(current) }, newValues: { pricePerUnit: price } });
        }
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) back(error.message.slice("VALIDATION:".length));
    if (isUniqueViolation(error)) back("Un autre prix vient d’être enregistré");
    throw error;
  }
  redirect("/resources");
}

/** Hard-deletes only unused resources; anything referenced by movements, prices, transactions or recipes is deactivated. */
export async function deleteResource(formData: FormData) {
  const session = await requireWriteAccess("settings:manage");
  const resourceId = formData.get("resourceId");
  if (typeof resourceId !== "string" || !resourceId || formData.get("confirm") !== "on") redirect("/resources?erreur=Confirmation%20requise");
  const resource = await prisma.resource.findUnique({ where: { id: resourceId as string }, include: { _count: { select: { movements: true, prices: true, transactionItems: true, recipeIngredients: true, recipeOutputs: true } } } });
  if (!resource) redirect("/resources?erreur=Ressource%20introuvable");
  const counts = resource!._count;
  const inUse = counts.movements + counts.prices + counts.transactionItems + counts.recipeIngredients + counts.recipeOutputs > 0;
  await prisma.$transaction(async (tx) => {
    if (inUse) {
      await tx.resource.update({ where: { id: resourceId as string }, data: { isActive: false } });
      await writeAudit(tx, { actorId: session.userId, action: "RESOURCE_DEACTIVATED", entityType: "Resource", entityId: resourceId as string, reason: "Historique présent : désactivation au lieu d’une suppression" });
    } else {
      await tx.resource.delete({ where: { id: resourceId as string } });
      await writeAudit(tx, { actorId: session.userId, action: "RESOURCE_DELETED", entityType: "Resource", entityId: resourceId as string, newValues: { code: resource!.code } });
    }
  });
  redirect("/resources");
}

const priceSchema = z.object({
  resourceId: z.string().min(1),
  price: z.coerce.number().int().min(0, "Prix invalide").max(MAX_UNIT_PRICE, `Prix maximum : ${MAX_UNIT_PRICE.toLocaleString("fr-FR")} Ryō`),
  reason: z.string().trim().min(3, "Un motif est obligatoire").max(300)
});

export async function updatePrice(formData: FormData) {
  const session = await requireWriteAccess("settings:manage");
  const parsed = priceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`/resources?erreur=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Saisie invalide")}`);
  const { resourceId, price, reason } = parsed.data!;
  try {
    await prisma.$transaction(async (tx) => {
      const locked = await lockResources(tx, [resourceId]);
      if (!locked.has(resourceId)) throw new Error("VALIDATION:Ressource introuvable");
      const previous = await activePrice(tx, resourceId);
      const now = new Date();
      await tx.resourcePriceHistory.updateMany({ where: { resourceId, effectiveTo: null }, data: { effectiveTo: now } });
      await tx.resourcePriceHistory.create({ data: { resourceId, pricePerUnit: BigInt(price), effectiveFrom: now, createdById: session.userId } });
      await writeAudit(tx, { actorId: session.userId, action: "PRICE_UPDATED", entityType: "Resource", entityId: resourceId, reason, previousValues: { pricePerUnit: previous === null ? null : Number(previous) }, newValues: { pricePerUnit: price } });
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) redirect(`/resources?erreur=${encodeURIComponent(error.message.slice("VALIDATION:".length))}`);
    if (isUniqueViolation(error)) redirect("/resources?erreur=Un%20autre%20prix%20vient%20d%E2%80%99%C3%AAtre%20enregistr%C3%A9");
    throw error;
  }
  redirect("/resources");
}
