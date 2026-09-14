import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, KeyRound, Pencil } from "lucide-react";
import { EmptyState, GradeBadge, MetricCard, MoneyDisplay, NinjaAvatar, PageHeader, PointDisplay, SectionHeader, StatusBadge } from "@koeki/ui";
import { DetailTabs } from "@/components/detail-tabs";
import { NinjaDonationItems } from "@/components/ninja-donation-items";
import { SettlementItems } from "@/components/settlement-items";
import { getNinjaDetail } from "@/lib/data";
import { lateYearsLabel } from "@/lib/format";
import { demoMode, hasPermission, requireSession } from "@/lib/session";
import { adjustPoints, changeGrade, recordNinjaDonation, recordPayment, waiveAssessment } from "../actions";
import { prisma } from "@koeki/database";
import { parseExemptionPolicy } from "@koeki/domain";

export default async function NinjaDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const { id } = await params;
  const query = await searchParams;
  const ownProfile = demoMode ? null : await prisma.ninjaProfile.findUnique({ where: { userId: session.userId }, select: { id: true } });
  if (!demoMode && session.roles.length === 1 && session.roles[0] === "NINJA") {
    if (!ownProfile) redirect("/profil");
    if (ownProfile.id !== id) redirect("/access-denied");
  }
  const canPay = hasPermission(session, "payments:write");
  const canWrite = hasPermission(session, "ninjas:write");
  const isOwner = ownProfile?.id === id;
  const [data, exemptionSetting, resourcesForDonation] = await Promise.all([
    getNinjaDetail(id, { canSeeNotes: canWrite || hasPermission(session, "audit:read") }),
    demoMode ? Promise.resolve(null) : prisma.appSetting.findUnique({ where: { key: "exemptionPolicy" } }),
    demoMode ? Promise.resolve([]) : prisma.resource.findMany({ where: { isActive: true }, orderBy: [{ exemptionPerUnit: "desc" }, { name: "asc" }] })
  ]);
  if (!data) notFound();
  const exemptionPolicy = parseExemptionPolicy(exemptionSetting?.value);
  const isActive = data.lifecycleStatus === "ACTIVE";
  const gradeNeedsUpdate = isActive && data.grade.code === "UNKNOWN";
  const donatable = !demoMode && canPay && isActive ? resourcesForDonation : [];
  const donationResourceOptions = donatable.map((resource) => {
    const points = resource.pointsPerUnit, rate = Number(resource.exemptionPerUnit);
    const detail = [points > 0 ? `${points} pts/u` : null, rate > 0 ? `${new Intl.NumberFormat("fr-FR").format(rate)} ¥/u` : null].filter(Boolean).join(" · ");
    return { id: resource.id, name: resource.name, donLabel: detail ? `${resource.name} — ${detail}` : resource.name, points, rate };
  });
  const receipt = typeof query.recu === "string" ? query.recu : null;
  const error = typeof query.erreur === "string" ? query.erreur : null;
  const info = typeof query.info === "string" ? query.info : null;
  const settleable = data.assessments.filter((row) => row.remaining > 0n || row.badge === "overdue" || row.badge === "due" || row.badge === "warning");

  const overviewTab = <>
    {canPay && !isActive && <p className="notice" role="status">Ce dossier est {data.statusLabel.toLowerCase()} : son historique reste consultable, mais aucune nouvelle opération fiscale ne peut être enregistrée.</p>}
    {gradeNeedsUpdate && <p className="notice" role="alert"><strong>Grade à mettre à jour.</strong> La situation de paiement n’est pas à jour. Dès qu’un grade réel sera enregistré, la taxe de la semaine en cours sera créée automatiquement au bon montant.</p>}
    {canPay && isActive && <section className="panel stack-panel">
      <SectionHeader title="Encaisser un règlement" description={exemptionPolicy.weeklyTaxCoverageBps > 0 ? `Cochez explicitement les semaines concernées. Le crédit des objets couvre au plus ${(exemptionPolicy.weeklyTaxCoverageBps / 100).toLocaleString("fr-FR")} % de chaque taxe.` : "Cochez explicitement les semaines concernées, puis saisissez les Ryō reçus. Les objets ne soldent actuellement aucune taxe."} />
      {settleable.length ? <form action={recordPayment} className="form-grid">
        <input type="hidden" name="ninjaId" value={data.id} />
        <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
        <fieldset>
          <legend>Semaines à régler</legend>
          <div className="week-picker">
            {settleable.map((row) => <label key={row.id}>
              <input type="checkbox" name="years" value={row.id} />
              <span>RP {row.rpYear} <small>{row.period}</small> — {row.remaining > 0n ? <>reste <MoneyDisplay amount={row.remaining} />{row.penalties > 0n && <> (dont majorations <MoneyDisplay amount={row.penalties} />)</>}</> : "impayée (ancien registre)"}</span>
            </label>)}
          </div>
        </fieldset>
        <SettlementItems taxCoverageBps={exemptionPolicy.weeklyTaxCoverageBps} resources={donatable.map((resource) => ({ id: resource.id, name: resource.name, label: `${resource.name}${resource.exemptionPerUnit > 0n ? ` — crédit ${new Intl.NumberFormat("fr-FR").format(Number(resource.exemptionPerUnit))} ¥/u` : ""}${resource.pointsPerUnit > 0 ? ` · ${resource.pointsPerUnit} pts/u` : ""}`, rate: Number(resource.exemptionPerUnit) }))} />
        <label>Référence (facultatif)<input type="text" name="reference" maxLength={120} placeholder="Arrangement, contexte…" /></label>
        <div className="form-actions"><button className="button button-primary" type="submit"><KeyRound size={16} /> Régler les semaines cochées</button></div>
      </form> : <p className="notice" style={{ margin: 18 }}>{gradeNeedsUpdate ? "Renseignez d’abord le grade dans l’onglet Gestion : la semaine en cours sera alors facturée immédiatement." : <>Rien à encaisser : aucune semaine ouverte. La prochaine taxe sera générée dimanche minuit{data.exemptionBalance > 0n && exemptionPolicy.weeklyTaxCoverageBps > 0 ? ` ; le crédit pourra en couvrir jusqu’à ${(exemptionPolicy.weeklyTaxCoverageBps / 100).toLocaleString("fr-FR")} %` : ""}. Un don peut toujours être enregistré ci-dessous, ou un rachat depuis la page <Link href="/resources/transaction" className="text-link">Ressources</Link>.</>}</p>}
    </section>}
    {canPay && isActive && donationResourceOptions.length > 0 && <section className="panel stack-panel">
      <SectionHeader title="Faire un don" description="Enregistre un don de ressources pour ce ninja — points et crédit d’exonération calculés côté serveur. Pour un rachat (payé en Ryō), utilisez la page Ressources." />
      <form action={recordNinjaDonation} className="form-grid">
        <input type="hidden" name="ninjaId" value={data.id} />
        <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
        <NinjaDonationItems resources={donationResourceOptions} taxCoverageBps={exemptionPolicy.weeklyTaxCoverageBps} />
      </form>
    </section>}
    <div className="duo-grid">
      <section className="panel">
        <SectionHeader title="Identité" description="Registre administratif" />
        <div className="identity-list">
          <div className="person-cell" style={{ gridColumn: "1/-1" }}><NinjaAvatar name={data.name} /><span><strong>{data.name}</strong><small>{data.code}</small></span></div>
          <div><span>Grade</span><GradeBadge>{data.grade.label}</GradeBadge></div>
          <div><span>État</span>{data.statusLabel}</div>
          {data.diedAt && <div><span>Date du décès</span>{data.diedAt}</div>}
          <div><span>Clan</span>{data.clan ?? "—"}</div>
          <div><span>Pseudonyme</span>{data.alias ?? "—"}</div>
          <div style={{ gridColumn: "1/-1" }}><span>Compte lié</span>{data.hasLinkedUser ? "Compte Discord associé" : "Aucun compte Discord associé"}</div>
          {data.notes && <div style={{ gridColumn: "1/-1" }}><span>Notes internes</span><div className="notes-block">{data.notes}</div></div>}
        </div>
      </section>
      <section className="panel">
        <SectionHeader title="Points" description="Dernières écritures du registre" />
        {data.pointEntries.length ? <div className="mini-list">{data.pointEntries.map((entry) => <div key={entry.id}><span>{entry.label}{entry.reason && <small>{entry.reason}</small>}<small>{entry.at}</small></span><strong className={entry.points < 0 ? "negative" : "positive"}>{entry.points > 0 ? "+" : ""}{entry.points} pts</strong></div>)}</div>
          : <EmptyState title="Aucun point" description="Les points gagnés apparaîtront ici." />}
      </section>
    </div>
  </>;

  const taxesTab = <section className="panel stack-panel">
    <SectionHeader title="Historique fiscal" description="Une ligne par semaine RP — montant, majorations, corrections, payé, reste" />
    {data.assessments.length ? <div className="table-scroll"><table><thead><tr><th>Année</th><th>Grade</th><th className="num">Montant</th><th className="num">Majorations</th><th className="num">Corrections</th><th className="num">Payé</th><th className="num">Reste</th><th>Statut</th></tr></thead><tbody>{data.assessments.map((row) => <tr key={row.id}><td><strong>RP {row.rpYear}</strong><br /><small style={{ color: "var(--sand-500)", whiteSpace: "nowrap" }}>{row.period}</small></td><td>{row.gradeLabel}</td><td className="num"><MoneyDisplay amount={row.original} /></td><td className={`num ${row.penalties > 0n ? "negative" : "muted"}`}>{row.penalties > 0n ? <MoneyDisplay amount={row.penalties} /> : "—"}</td><td className="num muted">{row.adjustments !== 0n || row.exemptions !== 0n ? <MoneyDisplay amount={row.adjustments - row.exemptions} /> : "—"}</td><td className="num positive"><MoneyDisplay amount={row.paid} /></td><td className={`num ${row.remaining > 0n || row.badge === "overdue" ? "negative" : "muted"}`}>{row.remaining > 0n ? <MoneyDisplay amount={row.remaining} /> : row.badge === "overdue" ? "Impayée (ancien registre)" : "Soldé"}</td><td><StatusBadge status={row.badge}>{row.statusLabel}</StatusBadge></td></tr>)}</tbody></table></div>
      : <EmptyState title="Aucune taxe" description="Aucune semaine fiscale n’a encore été générée pour ce dossier." />}
  </section>;

  const operationsTab = <section className="panel stack-panel">
    <SectionHeader title="Historique économique" description="Paiements, dons et rachats liés au dossier" />
    {data.operations.length ? <div className="table-scroll"><table><thead><tr><th>Reçu</th><th>Opération</th><th className="num">Montant</th><th>État</th><th>Date</th></tr></thead><tbody>{data.operations.map((operation) => <tr key={operation.id}><td><code>{operation.receipt}</code></td><td>{operation.label}</td><td className="num"><MoneyDisplay amount={operation.amount} /></td><td><StatusBadge status={operation.badge}>{operation.statusLabel}</StatusBadge></td><td>{operation.at}</td></tr>)}</tbody></table></div>
      : <EmptyState title="Aucune opération" description="Les reçus apparaîtront ici dès la première écriture." />}
  </section>;

  const adminTab = <div className="duo-grid">
    {isActive && <section className="panel">
      <SectionHeader title="Changer le grade" description="Historisé et motif obligatoire — renseigner le grade ouvre immédiatement la semaine en cours" />
      <form action={changeGrade} className="form-grid">
        <input type="hidden" name="ninjaId" value={data.id} />
        <div className="form-row">
          <label>Nouveau grade<select name="gradeId" required defaultValue={data.grades.find((grade) => grade.code === data.grade.code)?.id ?? ""}>{gradeNeedsUpdate && <option value="" disabled>Sélectionner un grade…</option>}{data.grades.map((grade) => <option key={grade.id} value={grade.id}>{grade.label}</option>)}</select></label>
          <label>Motif<input type="text" name="reason" required minLength={3} maxLength={300} placeholder="Promotion validée par le conseil…" /></label>
        </div>
        <div className="form-actions"><button className="button button-ghost" type="submit">Appliquer le changement</button></div>
      </form>
    </section>}
    {settleable.length > 0 && <section className="panel">
      <SectionHeader title="Remettre une semaine" description="Annule la semaine sans encaissement — motif obligatoire, audité" />
      <form action={waiveAssessment} className="form-grid">
        <input type="hidden" name="ninjaId" value={data.id} />
        <div className="form-row">
          <label>Semaine concernée<select name="assessmentId" required>{settleable.map((row) => <option key={row.id} value={row.id}>RP {row.rpYear} — {row.remaining > 0n ? `reste ${new Intl.NumberFormat("fr-FR").format(Number(row.remaining))} ¥` : "impayée (ancien registre)"}</option>)}</select></label>
          <label>Motif *<input type="text" name="reason" required minLength={3} maxLength={300} placeholder="Geste commercial, erreur…" /></label>
        </div>
        <div className="form-actions"><button className="button button-ghost" type="submit">Remettre cette semaine</button></div>
      </form>
    </section>}
    {isActive && <section className="panel">
      <SectionHeader title="Ajuster les points" description="Récompense ou correction ponctuelle, hors des flux normaux — motif obligatoire, audité" />
      <form action={adjustPoints} className="form-grid">
        <input type="hidden" name="ninjaId" value={data.id} />
        <div className="form-row">
          <label>Points (+ ou -)<input type="number" name="points" required step={1} placeholder="ex: 50 ou -20" /></label>
          <label>Motif<input type="text" name="reason" required minLength={3} maxLength={300} placeholder="Récompense événement, correction…" /></label>
        </div>
        <div className="form-actions"><button className="button button-ghost" type="submit">Appliquer l’ajustement</button></div>
      </form>
    </section>}
  </div>;

  const tabs = [
    { id: "apercu", label: "Aperçu", content: overviewTab },
    { id: "taxes", label: "Semaines fiscales", count: data.assessments.length, content: taxesTab },
    { id: "operations", label: "Opérations", count: data.operations.length, content: operationsTab },
    ...(canWrite ? [{ id: "gestion", label: "Gestion", content: adminTab }] : [])
  ];

  return <div className="page-wrap">
    <PageHeader eyebrow={`Dossier ${data.code}`} title={data.name} description={`${data.grade.label}${data.alias ? ` · « ${data.alias} »` : ""} · ${data.statusLabel}`}
      actions={<>{(canWrite || isOwner) && <Link className="button button-ghost" href={`/ninjas/${data.id}/modifier`}><Pencil size={17} /> Modifier</Link>}<Link className="button button-ghost" href="/ninjas"><ArrowLeft size={17} /> Registre des ninjas</Link></>} />
    {receipt && <p className="notice" role="status">Paiement validé — reçu <code>{receipt}</code> enregistré et audité.</p>}
    {info && <p className="notice" role="status">{info}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}

    <section className="metric-grid" aria-label="Situation fiscale">
      <MetricCard label="Dette totale" value={<MoneyDisplay amount={data.totalDebt} />} detail={data.totalDebt > 0n ? "Majorations comprises" : gradeNeedsUpdate ? "Grade à renseigner avant facturation" : "Aucune dette ouverte"} tone={data.totalDebt > 0n ? "danger" : gradeNeedsUpdate ? "warn" : "good"} />
      <MetricCard label="Crédit d’exonération" value={<MoneyDisplay amount={data.exemptionBalance} />} detail={`Entrées historiques +${data.exemptionGranted.toLocaleString("fr-FR")} ¥ · débits/corrections −${data.exemptionUsed.toLocaleString("fr-FR")} ¥ · application ${(exemptionPolicy.weeklyTaxCoverageBps / 100).toLocaleString("fr-FR")} % max.`} tone={data.exemptionBalance > 0n ? "good" : "neutral"} />
      <MetricCard label="Retard" value={lateYearsLabel(data.lateYears)} detail={data.lateYears >= 2 ? "Dossier prioritaire" : "Sous surveillance normale"} tone={data.lateYears >= 2 ? "danger" : data.lateYears > 0 ? "warn" : "good"} />
      <MetricCard label="Points" value={<PointDisplay points={data.pointsBalance} />} detail="Solde explicable depuis le registre" tone="neutral" />
    </section>

    <DetailTabs tabs={tabs} />
  </div>;
}
