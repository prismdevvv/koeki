import { prisma, type Prisma } from "@koeki/database";
import { getSession, hasPermission } from "@/lib/session";

function csvEscape(value: string) {
  return /[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export async function GET() {
  const session = await getSession();
  if (!session || !hasPermission(session, "reports:read")) return Response.json({ error: "Accès refusé" }, { status: 403 });
  const canReadAll = hasPermission(session, "reports:read-all");
  const where: Prisma.AgentReportWhereInput = canReadAll ? { OR: [{ authorId: session.userId }, { status: { not: "DRAFT" } }] } : { authorId: session.userId };
  const [reports, users] = await Promise.all([
    prisma.agentReport.findMany({ where, orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }] }),
    prisma.user.findMany({ select: { id: true, name: true } })
  ]);
  const userNames = new Map(users.map((user) => [user.id, user.name ?? "Agent Kōeki"]));
  const header = ["Auteur", "Debut periode", "Fin periode", "Statut", "Paiements", "Dons/Rachats", "Montant traite (ryo)", "Corrections"];
  const lines = [header.join(";")];
  for (const report of reports) {
    lines.push([
      userNames.get(report.authorId) ?? "Agent Kōeki",
      report.periodStart.toISOString().slice(0, 10),
      report.periodEnd.toISOString().slice(0, 10),
      report.status,
      String(report.paymentCount),
      String(report.donationCount + report.buybackCount),
      (report.collectedAmount + report.processedValue).toString(),
      String(report.correctionCount)
    ].map(csvEscape).join(";"));
  }
  const csv = `﻿${lines.join("\n")}`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rapports-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store"
    }
  });
}
