import Link from "next/link";
import { UserPlus } from "lucide-react";
import { EmptyState, GradeBadge, PageHeader } from "@koeki/ui";
import { ZenkaiFilters } from "@/components/zenkai-filters";
import { formatDate } from "@/lib/format";
import { requirePermission } from "@/lib/session";
import { rankLabel, searchSunaCharacters } from "@/lib/zenkai";

export default async function ZenkaiPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission("ninjas:write");
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : undefined;
  const rank = typeof params.rank === "string" && params.rank ? params.rank : undefined;
  const division = typeof params.division === "string" && params.division ? params.division : undefined;

  let result;
  let error: string | null = null;
  try {
    result = await searchSunaCharacters({ q, rank, division });
  } catch {
    error = "L'API Zenkai est injoignable pour le moment — réessayez dans quelques instants.";
  }

  return <div className="page-wrap">
    <PageHeader eyebrow="Annuaire externe" title="Recherche Zenkai" description="Personnages de Suna suivis par l'API Zenkai — pour retrouver un shinobi avant d'ouvrir son dossier administratif." />
    {error && <p className="notice error" role="alert">{error}</p>}
    {result && <>
      <ZenkaiFilters ranks={result.ranks} divisions={result.divisions} />
      <section className="panel ninja-table-panel">
        {result.characters.length ? <div className="table-scroll">
          <table className="ninja-table">
            <thead><tr><th>Personnage</th><th>Rang</th><th>Division</th><th>Dernière connexion</th><th /></tr></thead>
            <tbody>{result.characters.map((character) => {
              const division = character.divisions.find((entry) => entry.faction === "Suna");
              const [firstName, ...restName] = character.name.trim().split(/\s+/);
              return <tr key={character.charKey}>
                <td><strong>{character.name}</strong></td>
                <td><GradeBadge>{rankLabel(character.rank)}</GradeBadge></td>
                <td>{division ? `${division.type}${division.grade ? ` (${division.grade})` : ""}` : "—"}</td>
                <td>{character.lastPlayedAt ? formatDate(new Date(character.lastPlayedAt)) : "—"}</td>
                <td className="num">
                  <Link className="text-link" href={`/ninjas/new?firstName=${encodeURIComponent(firstName ?? character.name)}&lastName=${encodeURIComponent(restName.join(" "))}`}>
                    <UserPlus size={15} /> Créer un dossier
                  </Link>
                </td>
              </tr>;
            })}</tbody>
          </table>
        </div> : <EmptyState title="Aucun joueur trouvé" description="Ajustez la recherche ou les filtres." />}
      </section>
      <footer className="panel table-footer ninja-register-footer"><span>{result.total.toLocaleString("fr-FR")} joueur{result.total > 1 ? "s" : ""} de Suna trouvé{result.total > 1 ? "s" : ""} sur Zenkai</span></footer>
    </>}
  </div>;
}
