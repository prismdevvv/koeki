"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Filter, Search } from "lucide-react";
import { rankLabel } from "@/lib/zenkai";

export function ZenkaiFilters({ ranks, divisions }: { ranks: Array<{ value: string; count: number }>; divisions: Array<{ value: string; count: number }> }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const navigate = (next: Partial<Record<"q" | "rank" | "division", string>>) => {
    const merged = { q: next.q ?? query, rank: next.rank ?? params.get("rank") ?? "", division: next.division ?? params.get("division") ?? "" };
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) if (value) search.set(key, value);
    router.replace(search.size ? `${pathname}?${search}` : pathname, { scroll: false });
  };

  return <form method="get" className="filter-bar" aria-label="Recherche et filtres" onSubmit={(event) => { event.preventDefault(); navigate({}); }}>
    <label className="search-field"><Search size={18} aria-hidden="true" /><span className="sr-only">Rechercher un joueur de Suna</span>
      <input type="search" name="q" value={query} placeholder="Nom du personnage…" autoComplete="off"
        onChange={(event) => { const value = event.target.value; setQuery(value); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => navigate({ q: value }), 250); }} />
    </label>
    <label className="sr-only" htmlFor="filter-rank">Rang</label>
    <select id="filter-rank" name="rank" className="button button-ghost" defaultValue={params.get("rank") ?? ""} onChange={(event) => navigate({ rank: event.target.value })}>
      <option value="">Tous les rangs</option>{ranks.map((entry) => <option key={entry.value} value={entry.value}>{rankLabel(entry.value)} ({entry.count})</option>)}
    </select>
    <label className="sr-only" htmlFor="filter-division">Division</label>
    <select id="filter-division" name="division" className="button button-ghost" defaultValue={params.get("division") ?? ""} onChange={(event) => navigate({ division: event.target.value })}>
      <option value="">Toutes divisions</option>{divisions.map((entry) => <option key={entry.value} value={entry.value}>{entry.value} ({entry.count})</option>)}
    </select>
    <button className="button button-ghost" type="submit"><Filter size={17} /> Filtrer</button>
  </form>;
}
