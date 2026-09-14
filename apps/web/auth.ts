import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@koeki/database";
import { findSunaCharacterByDiscordId } from "./lib/zenkai";
import { linkOrCreateNinjaForZenkaiCharacter, syncLogistiqueRole } from "./lib/ninja-link";

const refuse = (reason: string) => { console.warn(`[auth] connexion refusée : ${reason}`); return false; };

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database", maxAge: 60 * 60 * 12, updateAge: 60 * 15 },
  providers: [Discord({ clientId: process.env.DISCORD_CLIENT_ID ?? "", clientSecret: process.env.DISCORD_CLIENT_SECRET ?? "", authorization: { params: { scope: "identify guilds" } } })],
  pages: { signIn: "/connexion", error: "/access-denied" },
  cookies: { sessionToken: { name: "__Secure-koeki.session-token", options: { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" } } },
  callbacks: {
    async signIn({ user, account }) {
      const existing = user.id ? await prisma.user.findUnique({ where: { id: user.id }, include: { roles: true } }) : null;
      if (existing?.revokedAt) return refuse("compte révoqué");
      if (existing?.roles.length) return true;
      if (account?.provider !== "discord" || !account.access_token) return refuse("jeton d’accès Discord absent");
      const guildId = process.env.DISCORD_GUILD_ID;
      if (guildId) {
        const response = await fetch("https://discord.com/api/users/@me/guilds", { headers: { Authorization: `Bearer ${account.access_token}` }, cache: "no-store", signal: AbortSignal.timeout(8_000) })
          .catch(() => null);
        if (!response?.ok) return refuse(`vérification du serveur Discord impossible${response ? ` (HTTP ${response.status})` : " (délai dépassé ou service injoignable)"}`);
        const guilds = await response.json() as Array<{ id: string }>;
        if (!guilds.some((guild) => guild.id === guildId)) return refuse(`le compte n’appartient pas au serveur ${guildId} (${guilds.length} serveur${guilds.length > 1 ? "s" : ""} visibles)`);
      }
      // Accès direct pour tout ninja de Suna reconnu par l'API Zenkai (même logique que
      // hopital-suna — le compte Discord doit être lié à un personnage de la bonne faction).
      // Rôle NINJA de base attribué dans events.createUser, rôle Kōeki (staff) synchronisé
      // depuis la division logistique à chaque connexion dans events.signIn.
      const character = await findSunaCharacterByDiscordId(account.providerAccountId).catch(() => null);
      if (!character) return refuse("aucun personnage de Suna lié à ce compte Discord sur Zenkai");
      return true;
    },
    async session({ session, user }) {
      const current = await prisma.user.findUnique({ where: { id: user.id }, include: { roles: { include: { role: true } } } });
      if (!current || current.revokedAt) throw new Error("SESSION_REVOKED");
      session.user.id = current.id;
      (session.user as typeof session.user & { roles: string[] }).roles = current.roles.map((entry) => entry.role.code);
      return session;
    }
  },
  events: {
    async createUser({ user }) {
      // Compte auto-créé via la vérification Zenkai (signIn) : rôle NINJA de base,
      // le rattachement à une fiche ninja se fait ensuite sur /profil. Le rôle Kōeki
      // (staff) est synchronisé depuis la division logistique dans events.signIn.
      try {
        if (!user.id) throw new Error("USER_ID_MISSING");
        const ninjaRole = await prisma.role.findUnique({ where: { code: "NINJA" } });
        if (!ninjaRole) throw new Error("NINJA_ROLE_MISSING");
        await prisma.userRole.create({ data: { userId: user.id, roleId: ninjaRole.id, assignedById: user.id } });
      } catch (error) {
        console.warn(`[auth] attribution du rôle NINJA impossible pour le nouveau compte : ${error instanceof Error ? error.message : String(error)}`);
        if (user.id) await prisma.user.update({ where: { id: user.id }, data: { revokedAt: new Date() } }).catch(() => {});
      }
    },
    async linkAccount({ user, account }) {
      if (account.provider === "discord" && user.id) await prisma.user.update({ where: { id: user.id }, data: { discordId: account.providerAccountId } }).catch(() => {});
    },
    // Rattachement automatique au personnage RP (comme hopital-suna) : à chaque connexion
    // Discord, si le compte n'a pas encore de fiche ninja liée, on la réclame ou on la crée
    // à partir du personnage Zenkai correspondant à ce discordId.
    async signIn({ user, account }) {
      if (account?.provider !== "discord" || !user.id) return;
      const character = await findSunaCharacterByDiscordId(account.providerAccountId).catch(() => null);
      if (character) {
        await linkOrCreateNinjaForZenkaiCharacter(user.id, character);
        // Kōeki staff role (manager/agent) resynced from the Zenkai "logistique" division on
        // every login — a promotion or removal in-game takes effect immediately, no admin step.
        await syncLogistiqueRole(user.id, character);
      }
    }
  }
});
