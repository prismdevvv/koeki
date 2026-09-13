import { getRecovery } from "@/lib/data";
import { getSession, hasPermission } from "@/lib/session";

function csvEscape(value: string) {
  return /[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export async function GET() {
  const session = await getSession();
  if (!session || (!hasPermission(session, "payments:write") && !hasPermission(session, "audit:read"))) {
    return Response.json({ error: "Accès refusé" }, { status: 403 });
  }
  const data = await getRecovery();
  const header = ["Ninja", "Code", "Dette (ryo)", "Anciennete", "Agent", "Derniere relance"];
  const lines = [header.join(";")];
  for (const row of data.rows) {
    lines.push([row.name, row.code, row.debt.toString(), row.due, row.agent, row.lastContactedAt ?? ""].map(csvEscape).join(";"));
  }
  const csv = `﻿${lines.join("\n")}`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="recouvrement-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store"
    }
  });
}
