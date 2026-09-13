import Link from "next/link";
import { ArrowRight, CheckCircle2, UserCircle2 } from "lucide-react";
import { EmptyState, MetricCard, MoneyDisplay, PageHeader, PointDisplay, SectionHeader, StatusBadge } from "@koeki/ui";
import { DetailTabs } from "@/components/detail-tabs";
import { DonationDeclaration } from "@/components/donation-declaration";
import { DonsFilters } from "@/components/dons-filters";
import { ResourceFilters } from "@/components/resource-filters";
import { getInventory, getResources, getRpService } from "@/lib/data";
import { formatDateTime } from "@/lib/format";
import { demoMode, hasPermission, requireSession } from "@/lib/session";
import { prisma, type Prisma } from "@koeki/database";
import { parseExemptionPolicy } from "@koeki/domain";
import { recordAdjustment } from "../inventory/actions";
import { declareOwnDonation, rejectDonation, validateDonation } from "../dons/actions";
import { approveTransaction, updatePrice } from "./actions";

const formatRyo = (value: number) => new Intl.NumberFormat("fr-FR").format(value);

export default async function ResourcesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const query = await searchParams;
  const canManage = !demoMode && hasPermission(session, "settings:manage");
  const canApprove = !demoMode && session.roles.some((role) => role === "SUPER_ADMIN" || role === "KOEKI_MANAGER");
  const canWrite = !demoMode && hasPermission(session, "inventory:write");
  const canSeeInventory = hasPermission(session, "inventory:write") || hasPermission(session, "audit:read");
  const tab = typeof query.tab === "string" ? query.tab : "";
  const receipt = typeof query.recu === "string" ? query.recu : null;
  const error = typeof query.erreur === "string" ? query.erreur : null;
  const declared = typeof query.declare === "string" ? query.declare : null;
  const info = typeof query.info === "string" ? query.info : null;

  const dataResources = await getResources(canApprove, {
    q: typeof query.q === "string" ? query.q : undefined,
    categorie: typeof query.categorie === "string" && query.categorie ? query.categorie : undefined,
    besoin: typeof query.besoin === "string" && query.besoin ? query.besoin : undefined,
    etat: typeof query.etat === "string" && query.etat ? query.etat : undefined
  });

  const catalogueTab = <>
    {receipt && <p className="notice" role="status">Transaction validée — reçu <code>{receipt}</code>.</p>}
    {tab === "catalogue" && error && <p className="notice error" role="alert">{error}</p>}
    <section className="metric-grid">
      <MetricCard label="Rachats ce cycle" value={<MoneyDisplay amount={dataResources.metrics.buybackTotal} />} detail={`${dataResources.metrics.buybackCount} opération${dataResources.metrics.buybackCount > 1 ? "s" : ""}`} />
      <MetricCard label="Dons reçus" value={<MoneyDisplay amount={dataResources.metrics.donationValue} />} detail={`${dataResources.metrics.donationCount} don${dataResources.metrics.donationCount > 1 ? "s" : ""} · valeur estimée`} tone="good" />
      <MetricCard label="Validations en attente" value={String(dataResources.pendingApprovals.length)} detail={dataResources.pendingApprovals.length ? "Rachats au-dessus du seuil" : "Aucun rachat bloqué"} tone={dataResources.pendingApprovals.length ? "warn" : "neutral"} />
      <MetricCard label="Catalogue" value={String(dataResources.metrics.totalCount)} detail={`${dataResources.metrics.activeCount} ressources actives`} />
    </section>
    <section className="panel stack-panel">
      <SectionHeader title="Catalogue et tarification" description="Prix publics historisés, points et exonération gagnés par unité donnée, disponibilité du village."
        action={<>{canWrite && <Link className="button button-primary" href="/resources/transaction">Don ou rachat — chercher un ninja</Link>}{canManage && <Link className="text-link" href="/resources/new">Nouvelle ressource <ArrowRight size={15} /></Link>}</>} />
      <ResourceFilters categories={dataResources.categories} />
      {dataResources.resources.length ? <div className="table-scroll"><table><thead><tr><th>Code</th><th>Ressource</th><th>Catégorie</th><th>Prix unitaire</th><th>Points / don</th><th>Exonération / don</th><th>Stock</th><th>Besoin du village</th><th>Disponibilité</th></tr></thead><tbody>{dataResources.resources.map((resource) => <tr key={resource.id}><td><code>{resource.code}</code></td><td>{canManage ? <Link href={`/resources/${resource.id}/modifier`}><strong>{resource.name}</strong></Link> : <strong>{resource.name}</strong>}</td><td>{resource.category}</td><td>{resource.price > 0n ? <MoneyDisplay amount={resource.price} /> : <span className="muted">Non défini</span>}</td><td>{resource.points > 0 ? `${resource.points.toLocaleString("fr-FR")} pts` : <span className="muted">—</span>}</td><td>{resource.exemption > 0n ? <MoneyDisplay amount={resource.exemption} /> : <span className="muted">—</span>}</td><td>{resource.stock.toLocaleString("fr-FR")}</td><td>{resource.demand === "CRITICAL" ? <StatusBadge status="overdue">Critique</StatusBadge> : resource.demand === "NEEDED" ? <StatusBadge status="warning">Besoin</StatusBadge> : <span className="muted">—</span>}</td><td><StatusBadge status={resource.badge}>{resource.stateLabel}</StatusBadge></td></tr>)}</tbody></table></div>
        : <EmptyState title="Catalogue vide" description="Créez votre première ressource avec le lien « Nouvelle ressource » ci-dessus." />}
    </section>
    {(canApprove && dataResources.pendingApprovals.length > 0) || canManage ? <div className="duo-grid">
      {canApprove && dataResources.pendingApprovals.length > 0 && <section className="panel">
        <SectionHeader title="Validations en attente" description="Rachats au-dessus du seuil configuré" />
        <div className="mini-list">{dataResources.pendingApprovals.map((pending) => <div key={pending.id}><span><Link className="ninja-record-link" href={`/ninjas/${pending.ninjaId}`}><strong>{pending.ninja}</strong></Link><small>{pending.receipt} · {pending.at}</small></span><form action={approveTransaction} style={{ display: "flex", alignItems: "center", gap: 8 }}><MoneyDisplay amount={pending.total} /><input type="hidden" name="transactionId" value={pending.id} /><button className="button button-ghost" type="submit"><CheckCircle2 size={15} /> Valider</button></form></div>)}</div>
      </section>}
      {canManage && <section className="panel">
        <SectionHeader title="Modifier un prix" description="Historisé — n’affecte jamais les anciennes transactions" />
        <form action={updatePrice} className="form-grid">
          <label>Ressource<select name="resourceId" required>{dataResources.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></label>
          <div className="form-row">
            <label>Nouveau prix (Ryō)<input type="number" name="price" min={0} step={1} required /></label>
            <label>Motif<input type="text" name="reason" required minLength={3} maxLength={300} /></label>
          </div>
          <div className="form-actions"><button className="button button-ghost" type="submit">Appliquer le prix</button></div>
        </form>
      </section>}
    </div> : null}
  </>;

  let donsTab: React.ReactNode = null;
  if (demoMode) {
    donsTab = <p className="notice" role="status">Mode démonstration : les écritures sont désactivées.</p>;
  } else {
    const service = await getRpService();
    const rpYear = service.currentRpYear();
    const since = service.startOfRpYear(rpYear);
    const q = typeof query.q === "string" ? query.q.trim() : "";
    const statut = typeof query.statut === "string" ? query.statut : "";
    const isFiltered = Boolean(q || statut);
    const tokens = q.split(/\s+/).filter((token) => token && token !== "·");
    const registerWhere: Prisma.ResourceTransactionWhereInput = {
      type: "DONATION",
      status: statut === "valides" ? "VALIDATED" : statut === "attente" ? "PENDING_APPROVAL" : { in: ["VALIDATED", "PENDING_APPROVAL"] },
      AND: tokens.map((token) => ({ OR: [
        { ninja: { is: { OR: [{ firstName: { contains: token, mode: "insensitive" } }, { lastName: { contains: token, mode: "insensitive" } }, { code: { contains: token, mode: "insensitive" } }] } } },
        { receiptNumber: { contains: token, mode: "insensitive" } },
        { items: { some: { resource: { name: { contains: token, mode: "insensitive" } } } } }
      ] }))
    };
    const itemsInclude = { include: { resource: { select: { name: true, pointsPerUnit: true, exemptionPerUnit: true } } } } as const;
    const [profile, pending, recent, cyclePoints, cycleDons, allNinjas, exemptionSetting] = await Promise.all([
      prisma.ninjaProfile.findUnique({ where: { userId: session.userId }, select: { id: true, code: true, firstName: true, lastName: true, status: true } }),
      prisma.resourceTransaction.findMany({ where: { type: "DONATION", status: "PENDING_APPROVAL" }, orderBy: { createdAt: "asc" }, include: { ninja: { select: { id: true, code: true, firstName: true, lastName: true } }, items: itemsInclude } }),
      prisma.resourceTransaction.findMany({ where: registerWhere, orderBy: { createdAt: "desc" }, take: 100, include: { ninja: { select: { id: true, code: true, firstName: true, lastName: true } }, items: itemsInclude } }),
      prisma.pointLedgerEntry.aggregate({ where: { eventType: "DONATION", points: { gt: 0 }, createdAt: { gte: since } }, _sum: { points: true } }),
      prisma.resourceTransaction.findMany({ where: { type: "DONATION", status: "VALIDATED", validatedAt: { gte: since } }, select: { id: true } }),
      prisma.ninjaProfile.findMany({ where: { status: "ACTIVE" }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }], select: { firstName: true, lastName: true } }),
      prisma.appSetting.findUnique({ where: { key: "exemptionPolicy" } })
    ]);
    const exemptionPolicy = parseExemptionPolicy(exemptionSetting?.value);
    const searchSuggestions = [...allNinjas.map((ninja) => `${ninja.firstName} ${ninja.lastName}`), ...dataResources.resources.map((resource) => resource.name)];
    const [cycleExemption, grantedBySource] = await Promise.all([
      prisma.exemptionLedgerEntry.aggregate({ where: { sourceType: "ResourceTransaction", amount: { gt: 0 }, sourceId: { in: cycleDons.map((don) => don.id) } }, _sum: { amount: true } }),
      prisma.exemptionLedgerEntry.findMany({ where: { sourceType: "ResourceTransaction", amount: { gt: 0 }, sourceId: { in: recent.filter((don) => don.status === "VALIDATED").map((don) => don.id) } }, select: { sourceId: true, amount: true } })
    ]);
    const grantedMap = new Map(grantedBySource.map((entry) => [entry.sourceId, entry.amount]));
    type DonItems = Array<{ quantity: unknown; resource: { name: string; pointsPerUnit: number; exemptionPerUnit: bigint } }>;
    const estimate = (items: DonItems) => items.reduce((sum, item) => ({
      points: sum.points + Number(item.quantity) * item.resource.pointsPerUnit,
      exemption: sum.exemption + Number(item.quantity) * Number(item.resource.exemptionPerUnit)
    }), { points: 0, exemption: 0 });
    const contentOf = (items: DonItems) => items.map((item) => `${Number(item.quantity).toLocaleString("fr-FR")}× ${item.resource.name}`).join(", ");
    const donatable = dataResources.resources.map((resource) => ({ id: resource.id, name: resource.name, label: resource.name, points: resource.points, rate: Number(resource.exemption) }));
    donsTab = <>
      {declared && <p className="notice" role="status">Déclaration envoyée — reçu <code>{declared}</code>. Un agent doit la valider avant que les points et l’exonération soient crédités.</p>}
      {tab === "dons" && info && <p className="notice" role="status">{info}</p>}
      {tab === "dons" && error && <p className="notice error" role="alert">{error}</p>}
      <section className="metric-grid" aria-label="Dons du cycle">
        <MetricCard label={`Dons validés (année RP ${rpYear})`} value={String(cycleDons.length)} detail="Cycle en cours" />
        <MetricCard label="Points gagnés par dons" value={<PointDisplay points={cyclePoints._sum.points ?? 0} />} detail="Cycle en cours" tone="good" />
        <MetricCard label="Exonération accordée" value={<MoneyDisplay amount={cycleExemption._sum.amount ?? 0n} />} detail={`Crédit gagné et conservé · application ${(exemptionPolicy.weeklyTaxCoverageBps / 100).toLocaleString("fr-FR")} % max./taxe`} tone="good" />
        <MetricCard label="En attente de validation" value={String(pending.length)} detail={pending.length ? "Déclarations à traiter" : "Aucune déclaration en attente"} tone={pending.length ? "warn" : "neutral"} />
      </section>
      <div className="detail-grid" style={{ alignItems: "start" }}>
        <section className="panel">
          {profile && profile.status === "ACTIVE" ? <>
            <SectionHeader title="Déclarer mon don" description={`Au nom de ${profile.firstName} ${profile.lastName} (${profile.code}) — points et crédit d’exonération conservés après validation`} />
            <form action={declareOwnDonation} className="form-grid">
              <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
              <DonationDeclaration resources={donatable} taxCoverageBps={exemptionPolicy.weeklyTaxCoverageBps} />
            </form>
          </> : <>
            <SectionHeader title="Déclarer mon don" description="Votre compte n’est lié à aucune fiche ninja" />
            <p className="notice" style={{ margin: 18 }}>Pour déclarer un don, liez d’abord votre fiche depuis la page <Link href="/profil" className="text-link"><UserCircle2 size={14} /> Ma fiche</Link>. Vos dons seront crédités en points et dans votre solde d’exonération conservé.</p>
          </>}
        </section>
        {canWrite && <section className="panel">
          <SectionHeader title="Déclarations à valider" description="Vérifiez la remise réelle des objets avant de créditer" />
          {pending.length ? <div className="mini-list">{pending.map((don) => {
            const totals = estimate(don.items);
            return <div key={don.id} style={{ display: "block" }}>
              <span><Link className="ninja-record-link" href={`/ninjas/${don.ninja.id}`}><strong>{don.ninja.firstName} {don.ninja.lastName}</strong></Link><small>{don.receiptNumber} · {formatDateTime(don.createdAt)} — {contentOf(don.items)}</small></span>
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                <form action={validateDonation}><input type="hidden" name="transactionId" value={don.id} /><button className="button button-primary" type="submit" style={{ minHeight: 32 }}>Valider · +{formatRyo(totals.points)} pts · {formatRyo(totals.exemption)} ¥</button></form>
                <form action={rejectDonation} style={{ display: "flex", gap: 8, flex: 1, minWidth: 220 }}><input type="hidden" name="transactionId" value={don.id} /><input name="reason" placeholder="Motif du refus (facultatif)" maxLength={300} style={{ flex: 1 }} /><button className="button button-ghost" type="submit" style={{ minHeight: 32 }}>Refuser</button></form>
              </div>
            </div>;
          })}</div> : <EmptyState title="Rien à valider" description="Les déclarations des ninjas apparaîtront ici." />}
        </section>}
      </div>
      <section className="panel stack-panel">
        <SectionHeader title="Registre des dons" description={isFiltered ? "Résultats filtrés — 100 plus récents" : "Les 100 derniers dons — validés et en attente"} />
        <DonsFilters suggestions={searchSuggestions} />
        {recent.length ? <div className="table-scroll"><table><thead><tr><th>Date</th><th>Ninja</th><th>Contenu</th><th>Points</th><th>Exonération</th><th>Statut</th><th>Reçu</th></tr></thead><tbody>
          {recent.map((don) => {
            const totals = estimate(don.items);
            const granted = grantedMap.get(don.id);
            const isPending = don.status === "PENDING_APPROVAL";
            return <tr key={don.id}>
              <td>{formatDateTime(don.createdAt)}</td>
              <td><Link className="ninja-record-link" href={`/ninjas/${don.ninja.id}`}><strong>{don.ninja.firstName} {don.ninja.lastName}</strong></Link> <small style={{ color: "var(--sand-500)" }}>{don.ninja.code}</small></td>
              <td>{contentOf(don.items) || <span className="muted">—</span>}</td>
              <td>{isPending ? <span className="muted">~{formatRyo(totals.points)}</span> : <PointDisplay points={don.totalPoints} />}</td>
              <td>{isPending ? <span className="muted">~{formatRyo(totals.exemption)} ¥</span> : granted !== undefined ? <MoneyDisplay amount={granted} /> : totals.exemption > 0 ? <MoneyDisplay amount={BigInt(Math.round(totals.exemption))} /> : <span className="muted">—</span>}</td>
              <td><StatusBadge status={isPending ? "pending" : "paid"}>{isPending ? "En attente" : "Validé"}</StatusBadge></td>
              <td><code>{don.receiptNumber}</code></td>
            </tr>;
          })}
        </tbody></table></div> : <EmptyState title={isFiltered ? "Aucun don ne correspond" : "Aucun don"} description={isFiltered ? "Essayez un autre ninja, objet ou numéro de reçu, ou réinitialisez les filtres." : "Les dons validés et les déclarations apparaîtront ici."} />}
      </section>
    </>;
  }

  let inventaireTab: React.ReactNode = null;
  if (canSeeInventory) {
    const inventory = await getInventory();
    inventaireTab = <>
      {tab === "inventaire" && error && <p className="notice error" role="alert">{error}</p>}
      <section className="metric-grid">
        <MetricCard label="Valeur estimée" value={<MoneyDisplay amount={inventory.metrics.stockValue} />} detail="Au dernier prix connu" />
        <MetricCard label="Mouvements aujourd’hui" value={String(inventory.metrics.movementsToday)} detail={`${inventory.metrics.inToday} entrées · ${inventory.metrics.outToday} sorties`} />
        <MetricCard label="Stocks critiques" value={String(inventory.metrics.criticalCount)} detail={inventory.metrics.criticalCount ? "Action nécessaire" : "Aucun seuil critique franchi"} tone={inventory.metrics.criticalCount ? "danger" : "good"} />
        <MetricCard label="Stocks bas" value={String(inventory.metrics.lowCount)} detail={inventory.metrics.lowCount ? "Réapprovisionnement à planifier" : "Niveaux conformes"} tone={inventory.metrics.lowCount ? "warn" : "good"} />
      </section>
      <div className="duo-grid">
        <section className="panel stack-panel">
          <SectionHeader title="Derniers mouvements" description="Journal chronologique" />
          {inventory.alerts.length > 0 && <div className="inventory-board">{inventory.alerts.slice(0, 3).map((alert) => <div key={alert.id} className={`stock-card ${alert.level === "critical" ? "critical" : "warning"}`}><span>{alert.level === "critical" ? "Critique" : "Bas"}</span><strong>{alert.name}</strong><b>{alert.stock.toLocaleString("fr-FR")}</b><small>Seuil {alert.level === "critical" ? "critique" : "bas"} : {alert.threshold.toLocaleString("fr-FR")}</small></div>)}</div>}
          {inventory.movements.length ? <div className="table-scroll"><table><thead><tr><th>Date</th><th>Ressource</th><th>Type</th><th>Quantité</th><th>Agent</th><th>Justification</th></tr></thead><tbody>{inventory.movements.map((movement) => <tr key={movement.id}><td>{movement.at}</td><td><strong>{movement.resource}</strong></td><td>{movement.type}</td><td className={movement.quantity < 0 ? "negative" : "positive"}>{movement.quantity > 0 ? "+" : ""}{movement.quantity.toLocaleString("fr-FR")}</td><td>{movement.agent}</td><td>{movement.justification}</td></tr>)}</tbody></table></div>
            : <EmptyState title="Aucun mouvement" description="Les dons, rachats, fabrications et ajustements alimenteront ce journal." />}
        </section>
        {!demoMode && canWrite && <section className="panel">
          <SectionHeader title="Ajustement contrôlé" description="Chaque variation crée un mouvement immuable" />
          <form action={recordAdjustment} className="form-grid">
            <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
            <label>Ressource<select name="resourceId" required>{inventory.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name} — stock {resource.stock.toLocaleString("fr-FR")}</option>)}</select></label>
            <label>Quantité (négatif = sortie)<input type="number" name="quantity" step={1} required placeholder="-2" /></label>
            <label>Justification<input type="text" name="justification" required minLength={3} maxLength={300} placeholder="Inventaire physique du 4 août…" /></label>
            {canManage && <label style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" name="allowNegative" style={{ minHeight: 0, width: 16, height: 16 }} /> Autoriser un stock négatif (audité)</label>}
            <div className="form-actions"><button className="button button-primary" type="submit">Enregistrer le mouvement</button></div>
          </form>
        </section>}
      </div>
    </>;
  }

  const tabs = [
    { id: "catalogue", label: "Catalogue", content: catalogueTab },
    { id: "dons", label: "Dons", count: dataResources.pendingApprovals.length || undefined, content: donsTab },
    ...(canSeeInventory ? [{ id: "inventaire", label: "Inventaire", content: inventaireTab }] : [])
  ];

  return <div className="page-wrap">
    <PageHeader eyebrow="Économie du village" title="Ressources" description="Catalogue, dons et stocks — tout ce qui touche aux ressources de Suna en un seul endroit." />
    <DetailTabs tabs={tabs} defaultTab={tab || undefined} />
  </div>;
}
