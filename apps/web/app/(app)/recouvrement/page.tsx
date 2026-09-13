import Link from "next/link";
import { redirect } from "next/navigation";
import { Download } from "lucide-react";
import { EmptyState, MoneyDisplay, StatusBadge } from "@koeki/ui";
import { ModulePage } from "@/components/module-page";
import { getRecovery } from "@/lib/data";
import { hasPermission, requireSession } from "@/lib/session";
import { markContacted } from "./actions";

export default async function RecoveryPage() {
  const session = await requireSession();
  const canWrite = hasPermission(session, "payments:write");
  if (!canWrite && !hasPermission(session, "audit:read")) redirect("/access-denied");
  const data = await getRecovery();
  return <ModulePage eyebrow="File de suivi" title="Recouvrement" description="Dossiers à relancer, classés par ancienneté et exposition." registerDescription="Dette calculée depuis les écritures réelles" registerAction={<Link className="button button-ghost" href="/api/recouvrement/export"><Download size={15} /> Exporter en CSV</Link>} metrics={[
    { label: "Dette prioritaire", value: <MoneyDisplay amount={data.metrics.priorityDebt} />, detail: `${data.metrics.priorityCount} dossier${data.metrics.priorityCount > 1 ? "s" : ""} critiques`, tone: data.metrics.priorityCount ? "danger" : "good" },
    { label: "Retard moyen", value: data.metrics.averageLate, detail: "Sur les dossiers ouverts", tone: data.rows.length ? "warn" : "good" },
    { label: "Dette en retard", value: <MoneyDisplay amount={data.metrics.totalDebt} />, detail: `${data.rows.length} dossier${data.rows.length > 1 ? "s" : ""} ouverts` },
    { label: "Reprise à régulariser", value: String(data.metrics.unassigned), detail: data.metrics.unassigned ? "Impayés de l’ancien registre" : "Aucun dossier hérité", tone: data.metrics.unassigned ? "warn" : "good" }
  ]}>
    {data.rows.length ?<form action={markContacted}><div className="table-scroll"><table><thead><tr>{canWrite && <th aria-label="Sélection" />}<th>Priorité</th><th>Ninja</th><th>Dette</th><th>Ancienneté</th><th>Agent</th><th>Dernière relance</th><th>État</th></tr></thead><tbody>{data.rows.map((row, index) => <tr key={row.id}>{canWrite && <td><input type="checkbox" name="ninjaId" value={row.id} aria-label={`Sélectionner ${row.name}`} /></td>}<td><strong>{String(index + 1).padStart(2, "0")}</strong></td><td><Link href={`/ninjas/${row.id}`}><strong>{row.name}</strong><br/><code>{row.code}</code></Link></td><td className={row.debt > 0n ? "negative" : "muted"}>{row.debt > 0n ? <MoneyDisplay amount={row.debt} /> : "Ancien registre"}</td><td>{row.due}</td><td>{row.agent}</td><td className={row.lastContactedAt ? undefined : "muted"}>{row.lastContactedAt ?? "Jamais"}</td><td>{row.debt > 0n ? <StatusBadge status="overdue">Relance requise</StatusBadge> : <StatusBadge status="warning">Reprise à régulariser</StatusBadge>}</td></tr>)}</tbody></table></div>
      {canWrite && <footer className="table-footer"><button className="button button-primary" type="submit">Marquer les dossiers sélectionnés comme contactés</button></footer>}</form>
    : <EmptyState title="Aucun dossier en retard" description="Tous les ninjas actifs sont à jour de leurs taxes." />}</ModulePage>;
}
