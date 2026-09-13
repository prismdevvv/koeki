"use server";

import { redirect } from "next/navigation";
import { writeAudit } from "@/lib/finance";
import { markNinjasContacted } from "@/lib/data";
import { prisma } from "@koeki/database";
import { requireWriteAccess } from "@/lib/session";

export async function markContacted(formData: FormData) {
  const session = await requireWriteAccess("payments:write");
  const ninjaIds = formData.getAll("ninjaId").filter((value): value is string => typeof value === "string" && value.length > 0);
  if (ninjaIds.length) {
    const count = await markNinjasContacted(session.userId, ninjaIds);
    if (count) await prisma.$transaction((tx) => Promise.all(ninjaIds.map((ninjaId) =>
      writeAudit(tx, { actorId: session.userId, action: "RECOVERY_CONTACTED", entityType: "NinjaProfile", entityId: ninjaId, reason: "Relance de recouvrement effectuée" })
    )));
  }
  redirect("/recouvrement");
}
