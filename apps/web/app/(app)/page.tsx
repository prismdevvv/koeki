import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, ArrowRight, Boxes, CircleCheck, Clock3, Plus, ReceiptText } from "lucide-react";
import { EmptyState, MetricCard, MoneyDisplay, PageHeader, SectionHeader, StatusBadge, ZoneTitle } from "@koeki/ui";
import { getDashboard } from "@/lib/data";
import { formatPercentBps } from "@/lib/format";
import { demoMode, hasPermission, requireSession } from "@/lib/session";
import { prisma } from "@koeki/database";

export default async function DashboardPage() {
  const session = await requireSession();
  const ownProfile = demoMode ? { id: "demo" } : await prisma.ninjaProfile.findUnique({ where: { userId: session.userId }, select: { id: true } });
  if (!demoMode && session.roles.length === 1 && session.roles[0] === "NINJA") redirect(ownProfile ? `/ninjas/${ownProfile.id}` : "/profil");
  const data = await getDashboard(session);
  const rate = formatPercentBps(data.recoveryRateBps);
  const canReadReports = hasPermission(session, "reports:read");
  const canWriteReports = !demoMode && hasPermission(session, "reports:write");
  const canReviewReports = !demoMode && hasPermission(session, "reports:review");
  return <div className="page-wrap">
    <PageHeader eyebrow={`Situation du village · année RP ${data.rpYear}`} title="Salle des comptes" description="Une lecture immédiate des finances, des échéances et des opérations à traiter."
      metrics={[
        { label: "Taux de recouvrement", value: rate },
        { label: "Dette ouverte", value: <MoneyDisplay amount={data.debt} /> },
        { label: "Grades à mettre à jour", value: String(data.priorities.gradesToUpdate) },
        { label: "Ninjas en retard", value: String(data.overdueNinjas) }
      ]}
      actions={<>{canWriteReports ? <Link className="button button-ghost" href="/reports/new"><ReceiptText size={17} /> Nouveau rapport</Link> : canReadReports ? <Link className="button button-ghost" href="/reports"><ReceiptText size={17} /> Voir les rapports</Link> : null}<Link className="button button-primary" href="/ninjas"><Plus size={17} /> Enregistrer</Link></>} />
    {!ownProfile && <p className="notice" role="status">Bienvenue à la Kōeki ! Vous n’avez pas encore de fiche ninja : <Link href="/profil" className="text-link">enregistrez votre identité de shinobi</Link> pour lier vos taxes, points et opérations à votre compte.</p>}

    <ZoneTitle title="Revenus de Suna" detail={`Année RP ${data.rpYear} — Ryō encaissés et exonérations déjà appliquées`} />
    <section className="metric-grid" aria-label="Revenus fiscaux">
      <MetricCard label="Taxes attendues" value={<MoneyDisplay amount={data.expected} />} detail="Montant brut appelé ce cycle" />
      <MetricCard label="Encaissées (Ryō)" value={<MoneyDisplay amount={data.collected} />} detail={`${rate} des taxes soldées, exonérations appliquées comprises`} tone="good" />
      <MetricCard label="Exonérations appliquées" value={<MoneyDisplay amount={data.exempted} />} detail="Historique du crédit consommé" tone="good" />
      <MetricCard label="Dette à recouvrer" value={<MoneyDisplay amount={data.debt} />} detail={`${data.overdueNinjas} ninja${data.overdueNinjas > 1 ? "s" : ""} nécessitent un suivi`} tone={data.debt > 0n ? "danger" : "good"} />
    </section>

    <div className="dashboard-grid">
      <section className="panel recovery-panel">
        <SectionHeader title="Recouvrement fiscal" description="Progression des encaissements par année RP" action={<Link href="/statistics" className="text-link">Détails <ArrowRight size={15} /></Link>} />
        <div className="recovery-summary"><div><span>Taux actuel</span><strong>{rate}</strong></div><div><span>Attendu</span><MoneyDisplay amount={data.expected} /></div><div><span>Encaissé</span><MoneyDisplay amount={data.collected} /></div><div><span>Exonérations appliquées</span><MoneyDisplay amount={data.exempted} /></div></div>
        {data.recoveryByYear.length > 0 ? <div className="bar-chart" role="img" aria-label={`Taux de recouvrement par année RP : ${data.recoveryByYear.map((entry) => `année ${entry.rpYear} ${entry.percent} %`).join(", ")}`}>
          {data.recoveryByYear.map((entry) => <div key={entry.rpYear}><span style={{ height: `${Math.max(3, entry.percent)}%` }}><i>{entry.percent}%</i></span><small>RP {entry.rpYear}</small></div>)}
        </div> : <EmptyState title="Aucune taxe générée" description="Lancez la génération annuelle depuis le worker pour ouvrir l’exercice." />}
        <p className="chart-summary">{data.previousDeltaBps === null ? "Première année fiscale suivie : aucune comparaison n’est encore disponible."
          : data.previousDeltaBps >= 0 ? `Le recouvrement progresse de ${formatPercentBps(data.previousDeltaBps)} par rapport à l’année RP ${data.rpYear - 1}.`
          : `Le recouvrement recule de ${formatPercentBps(-data.previousDeltaBps)} par rapport à l’année RP ${data.rpYear - 1}.`}</p>
      </section>

      <section className="panel alerts-panel">
        <SectionHeader title="À traiter" description="Actions prioritaires" />
        <div className="priority-list">
          {data.priorities.penaltyRateMissing && <Link href="/admin"><span className="priority-icon danger"><AlertTriangle /></span><span><strong>Taux de majoration absent</strong><small>L’automatisation reste désactivée</small></span><b>Configurer</b></Link>}
          {data.priorities.gradesToUpdate > 0 && <Link href="/ninjas?statut=grade_missing"><span className="priority-icon warn"><AlertTriangle /></span><span><strong>{data.priorities.gradesToUpdate} grade{data.priorities.gradesToUpdate > 1 ? "s" : ""} à mettre à jour</strong><small>Situation de paiement non à jour tant que le grade manque</small></span><b>Corriger</b></Link>}
          <Link href="/recouvrement"><span className="priority-icon warn"><Clock3 /></span><span><strong>{data.priorities.overdueCount} dossier{data.priorities.overdueCount > 1 ? "s" : ""} à relancer</strong><small>{data.priorities.overdueOldCount} dépasse{data.priorities.overdueOldCount > 1 ? "nt" : ""} deux années RP</small></span><b>Ouvrir</b></Link>
          <Link href="/resources?tab=inventaire"><span className="priority-icon"><Boxes /></span><span><strong>{data.priorities.criticalStocks.length} stock{data.priorities.criticalStocks.length > 1 ? "s" : ""} critique{data.priorities.criticalStocks.length > 1 ? "s" : ""}</strong><small>{data.priorities.criticalStocks.slice(0, 3).join(", ") || "Aucun seuil franchi"}</small></span><b>Vérifier</b></Link>
          {canReviewReports && <Link href="/reports?statut=SUBMITTED"><span className="priority-icon good"><CircleCheck /></span><span><strong>{data.priorities.reportsToReview} rapport{data.priorities.reportsToReview > 1 ? "s" : ""} à valider</strong><small>Soumis par les agents économiques</small></span><b>Examiner</b></Link>}
        </div>
      </section>
    </div>

    <ZoneTitle title="Économie et stocks" detail="Comptoir des ressources du village" />
    <section className="metric-grid" aria-label="Économie des ressources">
      <MetricCard label="Rachats ce cycle" value={<MoneyDisplay amount={data.buybacks} />} detail={`${data.buybackCount} transaction${data.buybackCount > 1 ? "s" : ""} validées`} />
      <MetricCard label="Valeur des stocks" value={<MoneyDisplay amount={data.stockValue} />} detail="Au dernier prix connu du catalogue" />
      <MetricCard label="Stocks critiques" value={String(data.priorities.criticalStocks.length)} detail={data.priorities.criticalStocks.slice(0, 3).join(", ") || "Aucun seuil franchi"} tone={data.priorities.criticalStocks.length ? "warn" : "good"} />
      {canReviewReports && <MetricCard label="Rapports à valider" value={String(data.priorities.reportsToReview)} detail="Journées soumises par les agents" tone={data.priorities.reportsToReview ? "warn" : "neutral"} />}
    </section>

    <ZoneTitle title="Dernières opérations" detail="Écritures du service économique" />
    <section className="panel activity-panel">
      <SectionHeader title="Registre du jour" description="Paiements, dons et rachats les plus récents" action={<Link href="/audit" className="text-link">Voir le registre d’audit <ArrowRight size={15} /></Link>} />
      {data.activity.length ? <div className="table-scroll"><table><thead><tr><th>Référence</th><th>Opération</th><th>Ninja</th><th className="num">Montant</th><th>État</th><th>Horodatage</th></tr></thead><tbody>{data.activity.map((item) => <tr key={item.code}><td><code>{item.code}</code></td><td>{item.label}</td><td><Link className="ninja-record-link" href={`/ninjas/${item.ninjaId}`}><strong>{item.subject}</strong></Link></td><td className={`num ${item.direction === "out" ? "negative" : "positive"}`}><MoneyDisplay amount={item.amount} /></td><td><StatusBadge status={item.status}>{item.statusLabel}</StatusBadge></td><td>{item.at}</td></tr>)}</tbody></table></div>
        : <EmptyState title="Aucune opération" description="Les paiements, dons et rachats enregistrés apparaîtront ici." />}
    </section>
  </div>;
}
