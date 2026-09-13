import { redirect } from "next/navigation";
import { AlertTriangle, Ban, CheckCircle2, Settings2, ShieldCheck, TimerReset } from "lucide-react";
import { EmptyState, PageHeader, SectionHeader, StatusBadge } from "@koeki/ui";
import { getAdmin } from "@/lib/data";
import { formatPercentBps } from "@/lib/format";
import { demoMode, hasPermission, requireSession } from "@/lib/session";
import { billCurrentWeek, revokeUserAccess, updateApprovalThreshold, updateExemptionPolicy, updatePenaltySettings, updateTaxRates, updateUserRoles } from "./actions";

export default async function AdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  if (!hasPermission(session, "settings:manage") && !hasPermission(session, "users:manage")) redirect("/access-denied");
  const query = await searchParams;
  const error = typeof query.erreur === "string" ? query.erreur : null;
  const info = typeof query.info === "string" ? query.info : null;
  const data = await getAdmin();
  const canUsers = !demoMode && hasPermission(session, "users:manage");
  const canWrite = !demoMode;
  const isSuper = hasPermission(session, "users:manage");
  const canRoles = !demoMode && hasPermission(session, "settings:manage");
  const assignableRoles = data.roles.filter((role) => isSuper || role.code !== "SUPER_ADMIN");
  const penaltyMissing = data.penalty.percentBps === null || !data.penalty.isValidated;
  return <div className="page-wrap">
    <PageHeader eyebrow="Accès responsable" title="Administration" description="Politiques, permissions et paramètres structurants." />
    {error && <p className="notice error" role="alert">{error}</p>}
    {info && <p className="notice" role="status">{info}</p>}
    {penaltyMissing && <div className="admin-alert" role="alert"><AlertTriangle /><div><strong>Le taux de majoration n’est pas configuré.</strong><p>Les majorations automatiques sont désactivées jusqu’à validation explicite d’un responsable.</p></div><a href="#penalty-panel">Configurer</a></div>}

    <div className="admin-grid">
      <section className="panel">
        <SectionHeader title="Comptes" description={(isSuper ? "Rôles modifiables — effet immédiat, chaque changement est audité" : "Rôles modifiables sauf super-administrateur (réservé aux super-admins) — effet immédiat") + ". Le rôle Kōeki (Agent économique / Super-administrateur) est resynchronisé automatiquement depuis la division logistique de Zenkai à chaque connexion — une modification manuelle ici est écrasée au prochain login."} />
        {data.users.length ? <div className="table-scroll"><table><thead><tr><th>Utilisateur</th><th>Rôles</th><th>État</th><th></th></tr></thead><tbody>{data.users.map((user) => <tr key={user.id}>
          <td><strong>{user.name}</strong></td>
          <td>{canRoles && (isSuper || !user.roleCodes.includes("SUPER_ADMIN")) ? <form action={updateUserRoles} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <input type="hidden" name="userId" value={user.id} />
            {assignableRoles.map((role) => <label key={role.code} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, whiteSpace: "nowrap" }}><input type="checkbox" name={`role_${role.code}`} defaultChecked={user.roleCodes.includes(role.code)} style={{ minHeight: 0, width: 14, height: 14 }} /> {role.label}</label>)}
            <button className="button button-ghost" type="submit" style={{ minHeight: 28 }}>Appliquer</button>
          </form> : <span title={user.roleCodes.includes("SUPER_ADMIN") && !isSuper ? "Compte super-administrateur — réservé aux super-admins" : undefined}>{user.roles}</span>}</td>
          <td><StatusBadge status={user.revoked ? "overdue" : "paid"}>{user.revoked ? "Révoqué" : "Actif"}</StatusBadge></td>
          <td>{canUsers && !user.revoked && <form action={revokeUserAccess}><input type="hidden" name="userId" value={user.id} /><button className="button button-ghost" style={{ minHeight: 30 }} type="submit"><Ban size={14} /> Révoquer</button></form>}</td>
        </tr>)}</tbody></table></div>
          : <EmptyState title="Aucun compte" description="Les comptes apparaissent après la première connexion Discord d’un shinobi de Suna reconnu sur Zenkai." />}
      </section>

      <aside style={{ display: "grid", gap: 12, alignContent: "start" }}>
        <section className="panel" id="bareme-panel">
          <SectionHeader title="Semaine fiscale en cours" description={`Semaine RP ${data.currentWeek.rpYear} · ${data.currentWeek.period} — échéance dimanche minuit`} />
          <div className="mini-list">
            <div><span>Ninjas facturés (grade renseigné)</span><strong>{data.currentWeek.lines} / {data.currentWeek.activeNinjas}</strong></div>
            <div><span>Dont réellement imposables</span><strong className={data.currentWeek.billable === 0 ? "negative" : "positive"}>{data.currentWeek.billable}</strong></div>
            <div><span>Grades à mettre à jour</span><strong className={data.currentWeek.gradesToUpdate > 0 ? "negative" : "positive"}>{data.currentWeek.gradesToUpdate}</strong></div>
          </div>
          {data.currentWeek.gradesToUpdate > 0 && <p className="notice" style={{ margin: "0 20px 16px" }} role="alert">Ces dossiers ne sont pas considérés à jour. Leur semaine sera facturée automatiquement dès qu’un grade réel sera enregistré.</p>}
          {data.currentWeek.billable === 0 && <p className="notice error" style={{ margin: "0 20px 16px" }} role="alert">Personne n’a de taxe à payer cette semaine : le barème est à 0 pour les grades des ninjas actifs. Renseignez les montants ci-dessous puis publiez, ou corrigez les grades.</p>}
          {canWrite && <form action={billCurrentWeek} className="form-grid" style={{ paddingTop: 0 }}>
            <div className="form-actions"><button className="button button-ghost" type="submit">Facturer la semaine en cours maintenant</button></div>
          </form>}
        </section>
        <section className="panel">
          <SectionHeader title="Barème hebdomadaire par grade" description={`Publier un nouveau barème refacture immédiatement la semaine en cours. Les paiements sont préservés ; le crédit d’exonération est plafonné à ${formatPercentBps(data.exemption.weeklyTaxCoverageBps)} par semaine.`} />
          {canWrite ? <form action={updateTaxRates} className="form-grid">
            {data.gradeRates.map((rate) => <div className="form-row" key={rate.gradeId} style={{ gridTemplateColumns: "1fr 140px", alignItems: "center" }}>
              <span style={{ fontSize: 12 }}>{rate.label}</span>
              <label className="sr-only" htmlFor={`rate-${rate.gradeId}`}>Taxe hebdomadaire {rate.label}</label>
              <input id={`rate-${rate.gradeId}`} type="number" name={`rate_${rate.gradeId}`} min={0} step={1} defaultValue={rate.amount} />
            </div>)}
            <div className="form-actions"><button className="button button-primary" type="submit">Publier le barème et refacturer la semaine</button></div>
          </form> : <p className="notice" style={{ margin: 18 }}>Mode démonstration : édition désactivée.</p>}
        </section>
        <section className="panel" id="exemption-panel">
          <SectionHeader title="Application du crédit d’exonération" description="Plafond par taxe hebdomadaire — les barèmes, crédits acquis et historiques restent toujours conservés" />
          {canWrite ? <form action={updateExemptionPolicy} className="form-grid">
            <label>Part maximale d’une taxe couverte (%)<input type="number" name="coveragePercent" min={0} max={100} step={0.01} required defaultValue={data.exemption.weeklyTaxCoverageBps / 100} /></label>
            <p className="notice" style={{ margin: 0 }} role="status">À 0 %, les dons et rachats continuent d’ajouter le montant d’exonération au dossier du ninja, mais aucun crédit ne réduit ses taxes. Les semaines déjà couvertes restent inchangées.</p>
            <div className="form-actions"><StatusBadge status={data.exemption.weeklyTaxCoverageBps === 0 ? "draft" : "paid"}>{data.exemption.weeklyTaxCoverageBps === 0 ? "Suspendue" : formatPercentBps(data.exemption.weeklyTaxCoverageBps)}</StatusBadge><button className="button button-ghost" type="submit">Enregistrer</button></div>
          </form> : <div className="mini-list"><div><span>Part appliquée par semaine</span><strong>{formatPercentBps(data.exemption.weeklyTaxCoverageBps)}</strong></div></div>}
        </section>
        <section className="panel" id="penalty-panel">
          <SectionHeader title="Majorations de retard" description="Aucune automatisation sans taux validé" />
          {canWrite ? <form action={updatePenaltySettings} className="form-grid">
            <div className="form-row">
              <label>Taux de majoration (% par semaine de retard)<input type="number" name="percent" min={0.01} max={100} step={0.01} defaultValue={data.penalty.percentBps === null ? "" : data.penalty.percentBps / 100} placeholder="Ex. 10" /></label>
              <label>Base de calcul<select name="basis" defaultValue={data.penalty.basis}><option value="ORIGINAL_TAX">Taxe originale</option><option value="REMAINING_PRINCIPAL">Principal restant</option><option value="CURRENT_DEBT">Dette actuelle</option></select></label>
            </div>
            <div className="form-row">
              <label>Applications maximum<input type="number" name="maxApplications" min={1} max={20} defaultValue={data.penalty.maxApplications} /></label>
              <label>Plafond de dette (Ryō)<input type="number" name="maxDebt" min={0} defaultValue={data.penalty.maxDebt} /></label>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" name="isRateValidated" defaultChecked={data.penalty.isValidated} style={{ minHeight: 0, width: 16, height: 16 }} /> Je valide explicitement ce taux</label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" name="isEnabled" defaultChecked={data.penalty.isEnabled} style={{ minHeight: 0, width: 16, height: 16 }} /> Activer l’application automatique</label>
            <div className="form-actions"><button className="button button-ghost" type="submit">Enregistrer</button></div>
          </form> : <div className="mini-list"><div><span>Taux</span><strong>{data.penalty.percentBps === null ? "Non défini" : formatPercentBps(data.penalty.percentBps)}</strong></div></div>}
        </section>
        <section className="panel">
          <SectionHeader title="Seuil d’approbation" description="Rachats importants soumis à validation" />
          {canWrite ? <form action={updateApprovalThreshold} className="form-grid">
            <label>Seuil (Ryō)<input type="number" name="amount" min={0} defaultValue={data.approval.amount} /></label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" name="isValidated" defaultChecked={data.approval.isValidated} style={{ minHeight: 0, width: 16, height: 16 }} /> Activer ce seuil (validation managériale)</label>
            <div className="form-actions"><button className="button button-ghost" type="submit">Enregistrer</button></div>
          </form> : null}
        </section>
        <section className="panel">
          <SectionHeader title="Configuration active" description="Paramètres versionnés et audités" />
          <div className="settings-list">
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, alignItems: "center", padding: "12px 17px", borderBottom: "1px solid var(--border)" }}><span className="setting-icon"><Settings2/></span><span><strong>Politique fiscale</strong><small style={{ display: "block", color: "var(--sand-500)" }}>{data.policy ? `${data.policy.name} v${data.policy.version} · ${data.policy.rateCount} grades` : "Aucune politique active"}</small></span><StatusBadge status={data.policy ? "paid" : "overdue"}>{data.policy ? "Active" : "Manquante"}</StatusBadge></div>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, alignItems: "center", padding: "12px 17px" }}><span className="setting-icon"><TimerReset/></span><span><strong>Temps RP</strong><small style={{ display: "block", color: "var(--sand-500)" }}>{data.rpTimeLabel}</small></span><StatusBadge status="paid">Configuré</StatusBadge></div>
          </div>
        </section>
        <section className="panel"><SectionHeader title="État du système" description="Contrôles de sécurité"/><div className="system-checks"><p><CheckCircle2/>Base Kōeki isolée</p><p><CheckCircle2/>Rôles synchronisés depuis Zenkai</p><p><CheckCircle2/>Sessions révocables</p><p><CheckCircle2/>Worker idempotent</p><p><CheckCircle2/>Indexation interdite</p><p><ShieldCheck/>Permissions vérifiées côté serveur</p></div></section>
      </aside>
    </div>
  </div>;
}
