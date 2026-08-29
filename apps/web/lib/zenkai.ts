import { cache } from "react";

const ZENKAI_API = "https://db.builtbyloris.dev";
const ZENKAI_FACTION = "Suna";
const PAGE_LIMIT = 500;

export const rankOrder = ["apprentis_genin", "genin", "genin confirme", "chunin", "chunin confirme", "tk-jonin", "jonin", "cmd", "kage"];
export const rankLabels: Record<string, string> = {
  apprentis_genin: "Apprenti genin", genin: "Genin", "genin confirme": "Genin confirmé",
  chunin: "Chunin", "chunin confirme": "Chunin confirmé", "tk-jonin": "Tokubetsu-jônin",
  jonin: "Jônin", cmd: "Commandant-jônin", kage: "Kazekage"
};
export const rankLabel = (rank: string) => rankLabels[rank] ?? rank;

export type ZenkaiDivision = { type: string; faction: string; grade: string | null; joinedAt: string | null; chief: boolean };
export type ZenkaiCharacter = {
  charKey: string; discordId: string; name: string; rank: string;
  lastPlayedAt: string | null; hidden: boolean; divisions: ZenkaiDivision[];
};

async function fetchZenkaiPage(page: number): Promise<{ data: ZenkaiCharacter[]; pages: number }> {
  const res = await fetch(`${ZENKAI_API}/api/characters?limit=${PAGE_LIMIT}&page=${page}&sort=name&order=asc`, { next: { revalidate: 120 } });
  if (!res.ok) throw new Error(`Zenkai API a répondu ${res.status}`);
  const body = await res.json();
  return { data: body.data ?? [], pages: body.pages ?? 1 };
}

// L'API Zenkai mélange les personnages de Konoha et de Suna sans filtre serveur par village —
// on récupère tout (paginé côté source) puis on ne garde que les fiches rattachées à une
// division de Suna, en cache 2 min pour ne pas marteler l'API externe à chaque recherche.
export const getSunaCharacters = cache(async (): Promise<ZenkaiCharacter[]> => {
  const first = await fetchZenkaiPage(1);
  const rest = await Promise.all(Array.from({ length: Math.max(0, first.pages - 1) }, (_, index) => fetchZenkaiPage(index + 2)));
  const all = first.data.concat(...rest.map((page) => page.data));
  return all.filter((character) => character.divisions.some((division) => division.faction === ZENKAI_FACTION) && !character.hidden);
});

export async function findSunaCharacterByDiscordId(discordId: string): Promise<ZenkaiCharacter | null> {
  const all = await getSunaCharacters();
  const matches = all.filter((character) => character.discordId === discordId);
  matches.sort((a, b) => new Date(b.lastPlayedAt ?? 0).getTime() - new Date(a.lastPlayedAt ?? 0).getTime());
  return matches[0] ?? null;
}

export type ZenkaiSearchResult = {
  characters: ZenkaiCharacter[];
  total: number;
  ranks: Array<{ value: string; count: number }>;
  divisions: Array<{ value: string; count: number }>;
};

export async function searchSunaCharacters(options: { q?: string | undefined; rank?: string | undefined; division?: string | undefined }): Promise<ZenkaiSearchResult> {
  const all = await getSunaCharacters();
  const rankCounts = new Map<string, number>();
  const divisionCounts = new Map<string, number>();
  for (const character of all) {
    rankCounts.set(character.rank, (rankCounts.get(character.rank) ?? 0) + 1);
    for (const division of character.divisions) if (division.faction === ZENKAI_FACTION) divisionCounts.set(division.type, (divisionCounts.get(division.type) ?? 0) + 1);
  }
  const q = options.q?.trim().toLowerCase();
  const filtered = all.filter((character) => {
    if (q && !character.name.toLowerCase().includes(q)) return false;
    if (options.rank && character.rank !== options.rank) return false;
    if (options.division && !character.divisions.some((division) => division.faction === ZENKAI_FACTION && division.type === options.division)) return false;
    return true;
  });
  return {
    characters: filtered,
    total: filtered.length,
    ranks: [...rankCounts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => rankOrder.indexOf(a.value) - rankOrder.indexOf(b.value)),
    divisions: [...divisionCounts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count)
  };
}
