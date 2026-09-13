"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { Prisma, prisma } from "@koeki/database";
import { isUniqueViolation, lockResources, parseFourDecimal, writeAudit } from "@/lib/finance";
import { hasPermission, requireWriteAccess } from "@/lib/session";

const adjustmentQuantitySchema = z.preprocess(
  (value) => typeof value === "string" ? value : "",
  z.string().trim()
    .refine((value) => parseFourDecimal(value) !== null, "La quantité doit avoir au maximum 4 décimales")
    .transform((value) => parseFourDecimal(value)!)
    .refine((value) => value !== 0 && Math.abs(value) <= 1_000_000, "La quantité doit être non nulle (± 1 000 000 max)")
);

const adjustmentSchema = z.object({
  resourceId: z.string().min(1, "Sélectionnez une ressource"),
  quantity: adjustmentQuantitySchema,
  justification: z.string().trim().min(3, "Une justification est obligatoire").max(300),
  allowNegative: z.literal("on").optional(),
  idempotencyKey: z.string().uuid()
});

export async function recordAdjustment(formData: FormData) {
  const session = await requireWriteAccess("inventory:write");
  const parsed = adjustmentSchema.safeParse(Object.fromEntries(formData));
  const back = (message: string): never => redirect(`/resources?tab=inventaire&erreur=${encodeURIComponent(message)}`);
  if (!parsed.success) back(parsed.error.issues[0]?.message ?? "Saisie invalide");
  const { resourceId, quantity, justification, allowNegative, idempotencyKey } = parsed.data!;
  const overrideAllowed = allowNegative === "on" && hasPermission(session, "settings:manage");
  try {
    await prisma.$transaction(async (tx) => {
      const locked = await lockResources(tx, [resourceId]);
      if (!locked.has(resourceId)) throw new Error("VALIDATION:Ressource introuvable");
      const resource = await tx.resource.findUnique({ where: { id: resourceId } });
      if (!resource) throw new Error("VALIDATION:Ressource introuvable");
      const aggregate = await tx.inventoryMovement.aggregate({ where: { resourceId }, _sum: { quantity: true } });
      const nextStock = new Prisma.Decimal(aggregate._sum.quantity ?? 0).add(new Prisma.Decimal(quantity));
      if (nextStock.isNegative() && !overrideAllowed) throw new Error("VALIDATION:Le stock deviendrait négatif — autorisation managériale explicite requise");
      await tx.inventoryMovement.create({ data: { resourceId, type: "MANUAL_ADJUSTMENT", quantity: new Prisma.Decimal(quantity), agentId: session.userId, justification, idempotencyKey } });
      await writeAudit(tx, { actorId: session.userId, action: nextStock.isNegative() ? "INVENTORY_ADJUSTED_NEGATIVE" : "INVENTORY_ADJUSTED", entityType: "Resource", entityId: resourceId, reason: justification, newValues: { quantity, nextStock: nextStock.toNumber() } });
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VALIDATION:")) back(error.message.slice("VALIDATION:".length));
    if (isUniqueViolation(error)) back("Ajustement déjà enregistré (double soumission détectée)");
    throw error;
  }
  redirect("/resources?tab=inventaire");
}
