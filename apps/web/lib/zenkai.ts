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

/** Characters actually played recently — used to pick a ninja for a transaction
 * without requiring a koeki fiche to already exist (the fiche is created on demand). */
export async function getRecentlyActiveSunaCharacters(days = 14): Promise<ZenkaiCharacter[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const all = await getSunaCharacters();
  return all.filter((character) => character.lastPlayedAt && new Date(character.lastPlayedAt).getTime() >= cutoff)
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

/** Maps the "logistique" Suna division (the Kōeki service on Zenkai) to a koeki
 * RBAC role. Real grade titles vary by sub-team ("Gerant Economique", "Co-Gérant",
 * "Responsable B.R.A.C", "Membre Shomu", "Membre B.R.A.C"…) so this matches on the
 * governing word rather than the full string. Any manager-tier grade gets full
 * administrative access (SUPER_ADMIN is only one permission — users:manage — ahead
 * of KOEKI_MANAGER, and the person actually running the service needs it). "Stagiaire"
 * (trainee) or no division at all keeps the account at the base Ninja role. */
export function logistiqueRoleFor(character: ZenkaiCharacter): "SUPER_ADMIN" | "ECONOMIC_AGENT" | null {
  const division = character.divisions.find((entry) => entry.faction === "Suna" && entry.type === "logistique");
  const grade = division?.grade ?? "";
  if (/g[ée]rant|responsable/i.test(grade)) return "SUPER_ADMIN";
  if (/membre/i.test(grade)) return "ECONOMIC_AGENT";
  return null;
}

export async function findSunaCharacterByCharKey(charKey: string): Promise<ZenkaiCharacter | null> {
  const all = await getSunaCharacters();
  return all.find((character) => character.charKey === charKey) ?? null;
}

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
