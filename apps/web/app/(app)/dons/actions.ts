"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { Prisma, prisma } from "@koeki/database";
import { activePrice, applyValidatedTransaction, isUniqueViolation, lockActiveNinja, nextTransactionReceipt, scaledTimes, withReceiptRetry, writeAudit } from "@/lib/finance";
import { requireWriteAccess } from "@/lib/session";

const declarationSchema = z.object({ idempotencyKey: z.string().uuid() });

/** A ninja declares their own donation: recorded PENDING_APPROVAL under their linked
 *  profile — points, exemption credit and stock only move once an agent validates. */
export async function declareOwnDonation(formData: FormData) {
  const session = await requireWriteAccess("self:read");
  const back = (message: string): never => redirect(`/resources?tab=dons&erreur=${encodeURIComponent(message)}`);
  const parsed = declarationSchema.safeParse({ idempotencyKey: formData.get("idempotencyKey") });
  if (!parsed.success) back("Saisie invalide — rechargez la page et réessayez");
  const { idempotencyKey } = parsed.data!;
  const profile = await prisma.ninjaProfile.findUnique({ where: { userId: session.userId }, select: { id: true, status: true } });
  if (!profile || profile.status !== "ACTIVE") back("Liez d’abord votre fiche ninja depuis la page « Ma fiche »");
  const lines: Array<{ resourceId: string; quantity: number }> = [];
  for (let index = 1; index <= 8; index++) {
    const resourceId = formData.get(`resourceId_${index}`);
    const quantityRaw = formData.get(`quantity_${index}`);
    if (typeof resourceId === "string" && resourceId && typeof quantityRaw === "string" && quantityRaw && quantityRaw !== "0") {
      const quantity = Number(quantityRaw);
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1_000_000) back(`Quantité invalide sur l’objet ${index} — nombre entier requis`);
      if (lines.some((line) => line.resourceId === resourceId)) back("Un même objet apparaît deux fois");
      lines.push({ resourceId, quantity });
    }
  }
  if (!lines.length) back("Ajoutez au moins un objet — tapez son nom puis choisissez une proposition de la liste");
  let receipt = "";
  try {
    receipt = await withReceiptRetry(() => prisma.$transaction(async (tx) => {
      if (!await lockActiveNinja(tx, profile!.id)) throw new Error("VALIDATION:Votre dossier ninja n’est plus actif");
      const items: Array<{ resourceId: string; quantity: number; unitPrice: bigint; lineTotal: bigint }> = [];
      for (const line of lines) {
        const resource = await tx.resource.findUnique({ where: { id: line.resourceId } });
        if (!resource || !resource.isActive) throw new Error("VALIDATION:Objet inconnu ou inactif");
        const unitPrice = (await activePrice(tx, line.resourceId)) ?? 0n;
        items.push({ resourceId: line.resourceId, quantity: line.quantity, unitPrice, lineTotal: scaledTimes(line.quantity, unitPrice) });
      }
      const receiptNumber = await nextTransactionReceipt(tx, "DONATION");
      const transaction = await tx.resourceTransaction.create({ data: {
        receiptNumber, type: "DONATION", status: "PENDING_APPROVAL", ninjaId: profile!.id, agentId: session.userId,
        totalAmount: items.reduce((total, item) => total + item.lineTotal, 0n), idempotencyKey
      } });
      await tx.resourceTransactionItem.createMany({ data: items.map((item) => ({ transactionId: transaction.id, resourceId: item.resourceId, quantity: new Prisma.Decimal(item.quantity), unitPriceSnapshot: item.unitPrice, lineTotal: item.lineTotal })) });
      await writeAudit(tx, { actorId: session.userId, action: "DONATION_DECLARED", entityType: "ResourceTransaction", entityId: transaction.id, reason: `Déclaration ${receiptNumber} par le ninja — en attente de validation`, newValues: { items: lines } });
      return receiptNumber;
    }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) back(error.message.slice("VALIDATION:".length));
    if (isUniqueViolation(error)) back("Cette déclaration a déjà été envoyée (double soumission détectée)");
    throw error;
  }
  redirect(`/resources?tab=dons&declare=${encodeURIComponent(receipt)}`);
}

/** An agent validates a declared donation: the validator becomes the responsible agent,
 *  then stock, points and exemption credit are applied exactly like an agent-recorded don. */
export async function validateDonation(formData: FormData) {
  const session = await requireWriteAccess("inventory:write");
  const transactionId = formData.get("transactionId");
  if (typeof transactionId !== "string" || !transactionId) redirect("/resources?tab=dons");
  let covered = 0n;
  try {
    await prisma.$transaction(async (tx) => {
      const transaction = await tx.resourceTransaction.findUnique({ where: { id: transactionId }, include: { items: { include: { resource: { select: { exemptionPerUnit: true, pointsPerUnit: true, isActive: true } } } } } });
      if (!transaction || transaction.type !== "DONATION" || transaction.status !== "PENDING_APPROVAL") throw new Error("VALIDATION:Déclaration déjà traitée");
      if (!await lockActiveNinja(tx, transaction.ninjaId)) throw new Error("VALIDATION:Le dossier ninja n’est plus actif");
      if (transaction.items.some((item) => !item.resource.isActive)) throw new Error("VALIDATION:Un objet de la déclaration est devenu inactif");
      const validated = await tx.resourceTransaction.updateMany({
        where: { id: transactionId, type: "DONATION", status: "PENDING_APPROVAL" },
        data: { status: "VALIDATED", validatedAt: new Date(), agentId: session.userId }
      });
      if (validated.count !== 1) throw new Error("VALIDATION:Déclaration déjà traitée");
      const applied = await applyValidatedTransaction(tx, { id: transaction.id, type: "DONATION", ninjaId: transaction.ninjaId, receiptNumber: transaction.receiptNumber, totalAmount: transaction.totalAmount, idempotencyKey: transaction.idempotencyKey },
        transaction.items.map((item) => ({ resourceId: item.resourceId, quantity: Number(item.quantity), unitPrice: item.unitPriceSnapshot, exemptionPerUnit: item.resource.exemptionPerUnit, pointsPerUnit: item.resource.pointsPerUnit })), session.userId);
      covered = applied.covered;
      await writeAudit(tx, { actorId: session.userId, action: "DONATION_APPROVED", entityType: "ResourceTransaction", entityId: transactionId, reason: `Validation de la déclaration ${transaction.receiptNumber}${applied.covered > 0n ? ` — ${Number(applied.covered).toLocaleString("fr-FR")} ¥ de taxes couverts par le crédit` : ""}` });
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) redirect(`/resources?tab=dons&erreur=${encodeURIComponent(error.message.slice("VALIDATION:".length))}`);
    if (isUniqueViolation(error)) redirect("/resources?tab=dons&erreur=Mouvements%20d%C3%A9j%C3%A0%20appliqu%C3%A9s");
    throw error;
  }
  const message = covered > 0n
    ? `Déclaration validée — points crédités et ${Number(covered).toLocaleString("fr-FR")} ¥ de taxes couverts automatiquement par le crédit d’exonération`
    : "Déclaration validée — points et exonération crédités";
  redirect(`/resources?tab=dons&info=${encodeURIComponent(message)}`);
}

/** An agent refuses a declared donation: the line is cancelled, nothing is credited. */
export async function rejectDonation(formData: FormData) {
  const session = await requireWriteAccess("inventory:write");
  const transactionId = formData.get("transactionId");
  const reasonRaw = formData.get("reason");
  const reason = typeof reasonRaw === "string" && reasonRaw.trim() ? reasonRaw.trim().slice(0, 300) : "Refusée sans motif détaillé";
  if (typeof transactionId !== "string" || !transactionId) redirect("/resources?tab=dons");
  try {
    await prisma.$transaction(async (tx) => {
      const transaction = await tx.resourceTransaction.findUnique({ where: { id: transactionId } });
      if (!transaction || transaction.type !== "DONATION" || transaction.status !== "PENDING_APPROVAL") throw new Error("VALIDATION:Déclaration déjà traitée");
      const rejected = await tx.resourceTransaction.updateMany({
        where: { id: transactionId, type: "DONATION", status: "PENDING_APPROVAL" },
        data: { status: "CANCELLED" }
      });
      if (rejected.count !== 1) throw new Error("VALIDATION:Déclaration déjà traitée");
      await writeAudit(tx, { actorId: session.userId, action: "DONATION_REJECTED", entityType: "ResourceTransaction", entityId: transactionId, reason: `Déclaration ${transaction.receiptNumber} refusée — ${reason}` });
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) redirect(`/resources?tab=dons&erreur=${encodeURIComponent(error.message.slice("VALIDATION:".length))}`);
    throw error;
  }
  redirect("/resources?tab=dons&info=D%C3%A9claration%20refus%C3%A9e");
}
