// Recovery of the 2 finished tournaments from the old deployment's /events page
// (koeki-web.up.railway.app, export of 2026-09-14).
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "postgresql://koeki:koeki@127.0.0.1:5432/koeki?schema=public" }) });
const FLAG = "legacyEventsImport2026-09-14";

const TOURNAMENTS = [
  { name: "Tournoi récolte #1", kind: "Tournoi", resourceFocus: "Toutes (hors Ryō)", startsAt: "2026-07-04T00:00:00Z", endsAt: "2026-07-14T00:00:00Z", participantCount: 116, winner: ["Kagemoto", "Shuni"] },
  { name: "Tournoi Lavande", kind: "Tournoi", resourceFocus: "Lavande", startsAt: "2026-07-20T00:00:00Z", endsAt: "2026-07-29T00:00:00Z", participantCount: 15, winner: ["Doma", "Nua"] }
];

async function main() {
  if (await prisma.appSetting.findUnique({ where: { key: FLAG } })) { console.log("import-events : déjà appliqué"); return; }
  let created = 0;
  for (const tournament of TOURNAMENTS) {
    const winner = await prisma.ninjaProfile.findFirst({ where: { firstName: tournament.winner[0], lastName: tournament.winner[1] } });
    await prisma.event.create({ data: {
      name: tournament.name, kind: tournament.kind, status: "FINISHED", resourceFocus: tournament.resourceFocus,
      startsAt: new Date(tournament.startsAt), endsAt: new Date(tournament.endsAt), participantCount: tournament.participantCount,
      winnerId: winner?.id ?? null, description: "Importé de l'ancien registre (migration Supabase, 14/09/2026)"
    } });
    created++;
  }
  await prisma.appSetting.create({ data: { key: FLAG, value: { importedAt: new Date().toISOString(), created } } });
  console.log(`import-events : ${created} tournois importés`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
