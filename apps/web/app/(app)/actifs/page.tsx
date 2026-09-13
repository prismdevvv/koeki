import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState, MoneyDisplay, StatusBadge } from "@koeki/ui";
import { ModulePage } from "@/components/module-page";
import { getActiveRoster } from "@/lib/data";
import { hasPermission, requireSession } from "@/lib/session";

export default async function ActiveRosterPage() {
  const session = await requireSession();
  if (!hasPermission(session, "payments:write") && !hasPermission(session, "audit:read")) redirect("/access-denied");
  const data = await getActiveRoster();
  return <ModulePage eyebrow="Vue serveur" title="Ninjas actifs" description="Personnages Suna joués sur Zenkai ces 2 dernières semaines, avec leur situation fiscale Kōeki." registerDescription="Trié par situation — les impayés en premier" metrics={[
    { label: "Actifs (2 sem.)", value: String(data.metrics.total), detail: "Personnages joués récemment" },
    { label: "Impayés", value: String(data.metrics.unpaid), detail: data.metrics.unpaid ? "À relancer" : "Tous à jour", tone: data.metrics.unpaid ? "danger" : "good" },
    { label: "Sans fiche Kōeki", value: String(data.metrics.noFile), detail: data.metrics.noFile ? "Jamais enregistrés" : "Tous ont une fiche", tone: data.metrics.noFile ? "warn" : "good" }
  ]}>{data.rows.length ? <div className="table-scroll"><table><thead><tr><th>Personnage</th><th>Grade</th><th>Dernière partie</th><th className="num">Dette</th><th>Situation</th></tr></thead><tbody>{data.rows.map((row) => <tr key={row.name}><td>{row.hasFile && row.ninjaId ? <Link href={`/ninjas/${row.ninjaId}`}><strong>{row.name}</strong>{row.code && <><br /><code>{row.code}</code></>}</Link> : <strong>{row.name}</strong>}</td><td>{row.rank}</td><td>{row.lastPlayedAt ?? "—"}</td><td className={`num ${row.debt > 0n ? "negative" : "muted"}`}>{row.debt > 0n ? <MoneyDisplay amount={row.debt} /> : "—"}</td><td>{row.hasFile ? <StatusBadge status={row.badge}>{row.statusLabel}</StatusBadge> : <StatusBadge status="pending">Sans fiche Kōeki</StatusBadge>}</td></tr>)}</tbody></table></div>
    : <EmptyState title="Aucun personnage actif" description="Personne n’a été joué sur Zenkai (faction Suna) ces 2 dernières semaines." />}</ModulePage>;
}
