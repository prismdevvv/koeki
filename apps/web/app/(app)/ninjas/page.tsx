import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ArrowRight, UserPlus } from "lucide-react";
import { EmptyState, GradeBadge, MoneyDisplay, NinjaAvatar, PageHeader, PointDisplay, StatusBadge } from "@koeki/ui";
import { NinjaFilters } from "@/components/ninja-filters";
import { NinjaViews } from "@/components/ninja-views";
import { getNinjas, searchUnfiledZenkaiCharacters } from "@/lib/data";
import { demoMode, hasPermission, requireSession } from "@/lib/session";
import { prisma } from "@koeki/database";
import { openZenkaiCharacter } from "./actions";

// Isolated in its own Suspense boundary so the (external, sometimes slow) Zenkai
// lookup never blocks the main registry table from showing up immediately.
async function UnfiledZenkaiSection({ query }: { query: string }) {
  const unfiled = await searchUnfiledZenkaiCharacters(query);
  if (!unfiled.length) return null;
  return <section className="panel ninja-table-panel">
    <header style={{ padding: "16px 20px 0" }}><h2 style={{ margin: 0, fontSize: 15 }}>Trouvés sur Zenkai, sans fiche Kōeki</h2><p className="muted" style={{ margin: "4px 0 0" }}>Ouvrez le dossier pour le créer et agir dessus (taxes, points, notes…).</p></header>
    <div className="table-scroll"><table className="ninja-table"><tbody>{unfiled.map((character) => <tr key={character.charKey}>
      <td><strong>{character.name}</strong></td>
      <td><GradeBadge>{character.rank}</GradeBadge></td>
      <td className="num"><form action={openZenkaiCharacter}><input type="hidden" name="charKey" value={character.charKey} /><button className="button button-ghost" type="submit"><UserPlus size={15} /> Ouvrir le dossier</button></form></td>
    </tr>)}</tbody></table></div>
  </section>;
}

export default async function NinjasPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  if (!demoMode && session.roles.length === 1 && session.roles[0] === "NINJA") {
    const own = await prisma.ninjaProfile.findUnique({ where: { userId: session.userId }, select: { id: true } });
    redirect(own ? `/ninjas/${own.id}` : "/profil");
  }
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : undefined;
  const grade = typeof params.grade === "string" && params.grade ? params.grade : undefined;
  const statut = typeof params.statut === "string" && params.statut ? params.statut : undefined;
  const data = await getNinjas({ q, grade, statut });
  const canWrite = hasPermission(session, "ninjas:write");
  const info = typeof params.info === "string" ? params.info : null;
  const error = typeof params.erreur === "string" ? params.erreur : null;
  const table = <section className="panel ninja-table-panel">
    {data.ninjas.length ? <div className="table-scroll"><table className="ninja-table"><thead><tr><th>Ninja</th><th>Grade</th><th>Situation</th><th className="num">Dette</th><th className="num">Points</th><th>Agent</th><th>Échéance</th></tr></thead><tbody>{data.ninjas.map((ninja) => <tr key={ninja.code}><td><Link href={`/ninjas/${ninja.id}`} className="person-cell"><NinjaAvatar name={ninja.name} /><span><strong>{ninja.name}</strong><small>{ninja.code}{ninja.alias && ` · ${ninja.alias}`}</small></span></Link></td><td><GradeBadge>{ninja.grade}</GradeBadge></td><td><StatusBadge status={ninja.badge}>{ninja.statusLabel}</StatusBadge></td><td className={`num ${ninja.debt > 0n ? "negative" : "muted"}`}>{ninja.debt ? <MoneyDisplay amount={ninja.debt} /> : "Aucune"}</td><td className="num"><PointDisplay points={ninja.points} /></td><td>{ninja.agent}</td><td>{ninja.due}</td></tr>)}</tbody></table></div>
      : <EmptyState title="Aucun ninja trouvé" description="Ajustez la recherche ou les filtres — tapez un nom pour chercher aussi parmi les personnages Zenkai actifs sans fiche." />}
  </section>;
  const cards = <section className="ninja-card-grid" aria-label="Registre des ninjas en cartes">{data.ninjas.map((ninja) => <article className="ninja-card" key={ninja.code}>
    <header><Link href={`/ninjas/${ninja.id}`} className="person-cell"><NinjaAvatar name={ninja.name} /><span><strong>{ninja.name}</strong><small>{ninja.code}</small></span></Link><StatusBadge status={ninja.badge}>{ninja.statusLabel}</StatusBadge></header>
    <div>
      <span><small>Grade</small><GradeBadge>{ninja.grade}</GradeBadge></span>
      <span><small>Dette</small><strong className={ninja.debt ? "negative" : "muted"}>{ninja.debt ? <MoneyDisplay amount={ninja.debt} /> : "Aucune"}</strong></span>
      <span><small>Points</small><PointDisplay points={ninja.points} /></span>
    </div>
    <div style={{ gridTemplateColumns: "1fr auto", alignItems: "center" }}>
      <span><small>Échéance</small><strong className="muted" style={{ fontWeight: 400 }}>{ninja.due}</strong></span>
      <Link className="text-link" href={`/ninjas/${ninja.id}`}>Voir <ArrowRight size={13} /></Link>
    </div>
  </article>)}</section>;
  return <div className="page-wrap">
    <PageHeader eyebrow="Registre administratif" title="Ninjas" description="Dossiers fiscaux des shinobis de Suna — taxes, points, dettes et suivi par agent."
      metrics={[
        { label: "Dossiers", value: new Intl.NumberFormat("fr-FR").format(data.stats.total) },
        { label: "À jour", value: new Intl.NumberFormat("fr-FR").format(data.stats.upToDate) },
        { label: "Grades à mettre à jour", value: new Intl.NumberFormat("fr-FR").format(data.stats.needsUpdate) },
        { label: "En retard", value: new Intl.NumberFormat("fr-FR").format(data.stats.overdue) },
        { label: "Décédés", value: new Intl.NumberFormat("fr-FR").format(data.stats.deceased) },
        { label: "Dette totale", value: <MoneyDisplay amount={data.stats.debt} /> }
      ]} />
    {info && <p className="notice" role="status">{info}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <NinjaFilters grades={data.grades} />
    <NinjaViews table={table} cards={cards} />
    <footer className="panel table-footer ninja-register-footer"><span>{data.total ? `${data.total.toLocaleString("fr-FR")} ninja${data.total > 1 ? "s" : ""} affiché${data.total > 1 ? "s" : ""} · chaque nom ouvre son dossier` : "0 ninja"}</span></footer>
    {canWrite && q && <Suspense fallback={<p className="notice" role="status" style={{ margin: 0 }}>Recherche sur Zenkai…</p>}>
      <UnfiledZenkaiSection query={q} />
    </Suspense>}
  </div>;
}
