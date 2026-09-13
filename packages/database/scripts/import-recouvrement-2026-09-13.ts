// One-shot recovery of the recouvrement debt list from the old register (koeki-web.up.railway.app,
// export of 2026-09-13, 289 real-debt rows transcribed from the UI — no direct DB access to that
// deployment). Each row becomes a fiche (grade "Non renseigné", real grade to be set later) plus a
// single "Ancien registre" tax year carrying the whole debt as an EXCEPTIONAL_DEBT adjustment, so
// the amount and the RP-years-late both match what was shown on the old site's Recouvrement page.
// Guarded by an AppSetting flag — safe to re-run, it no-ops once applied.
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createRpTimeService, defaultRpTimeConfig, rpTimeConfigSchema } from "@koeki/domain";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "postgresql://koeki:koeki@127.0.0.1:5432/koeki?schema=public" }) });
const FLAG = "legacyRecouvrementImport2026-09-13";

// [code, "First Last", debt in Ryo, RP years late]
const ROWS: Array<[string, string, number, number]> = [
  ["NIN-001481", "Akira Nori", 82700, 4], ["NIN-001559", "Yakira Katashiwa", 72800, 3], ["NIN-001308", "Sunao Chikatsume", 57500, 3],
  ["NIN-001618", "Sonemi Hakumei", 107500, 2], ["NIN-001013", "Yoru Akuma", 107500, 2], ["NIN-001070", "Fumetsu Chikawa", 107500, 2],
  ["NIN-001206", "Takumi Kageyama", 97500, 2], ["NIN-001366", "Shinku aketsu", 89500, 2], ["NIN-001508", "Kuroi Kenseki", 89500, 2],
  ["NIN-001421", "Yoru Amakari", 86000, 2], ["NIN-001565", "Ryuga Kuroki", 86000, 2], ["NIN-000850", "Ryo Arashi", 86000, 2],
  ["NIN-001227", "Reiji Kaze", 86000, 2], ["NIN-001250", "Raito Kamizuki", 86000, 2], ["NIN-001589", "Kuzan Kazenari", 86000, 2],
  ["NIN-001256", "Daiki Tsuchida", 86000, 2], ["NIN-001249", "Koruko Mitetsu", 85000, 2], ["NIN-001319", "Sohei Makabe", 81200, 2],
  ["NIN-001530", "Izan Kenseki", 78600, 2], ["NIN-001663", "Izan Shura", 64500, 2], ["NIN-001667", "Hakuren Kemuri", 64500, 2],
  ["NIN-001608", "Zenkiro Mushin", 64500, 2], ["NIN-001731", "Sajin Rensai", 64500, 2], ["NIN-001136", "harû omûra", 64500, 2],
  ["NIN-001593", "Sora Kesuke", 64500, 2], ["NIN-001497", "Shin Itsuki", 64500, 2], ["NIN-001646", "Senshiro Hachiman", 64500, 2],
  ["NIN-001724", "Zen Sennen", 64500, 2], ["NIN-001434", "Ryuji Omachi", 64500, 2], ["NIN-001501", "Riku Hagane", 64500, 2],
  ["NIN-001467", "Kai Hanazora", 64500, 2], ["NIN-001441", "Itsuki Amano", 64500, 2], ["NIN-001545", "Bushi Kishigami", 64500, 2],
  ["NIN-001519", "Shinda Ryokai", 63200, 2], ["NIN-001625", "Izumei Chiiketsu", 63200, 2], ["NIN-001601", "Shin Topo", 62000, 2],
  ["NIN-001419", "Sora Yamai", 61500, 2], ["NIN-001615", "meiro chiiketsu", 58600, 2], ["NIN-001566", "Kazuko Karu", 58500, 2],
  ["NIN-001694", "Ryuto Shiranui", 57500, 2], ["NIN-001337", "toya fuyukoshi", 55500, 2], ["NIN-001718", "Kakuno Shidako", 55500, 2],
  ["NIN-001634", "Ganko Ishida", 53500, 2], ["NIN-001656", "Yama Denmon", 43000, 2], ["NIN-001673", "Kyoma", 43000, 2],
  ["NIN-001661", "Kenjaku Moro", 43000, 2], ["NIN-001752", "Saraka Asakura", 43000, 2], ["NIN-001725", "Yua Saito", 43000, 2],
  ["NIN-001700", "Kyoga Bakkujin", 43000, 2], ["NIN-001446", "Itsubo Kakeho", 43000, 2], ["NIN-001675", "Zerei Fujind", 43000, 2],
  ["NIN-001676", "Hinae Kabuya", 43000, 2], ["NIN-001503", "Amamaru Izumi", 42120, 2], ["NIN-001542", "Ryoma Kenzaki", 41200, 2],
  ["NIN-001598", "Ren Kurogane", 41000, 2], ["NIN-001522", "Ryu Hoshi", 41000, 2], ["NIN-001560", "Azami Katashiwa", 41000, 2],
  ["NIN-001561", "Akira Arashi", 39700, 2], ["NIN-001517", "Akira Matsuoka", 39400, 2], ["NIN-001628", "Rizoku Amado", 35500, 2],
  ["NIN-001699", "Jin Takeda", 35200, 2],
  ["NIN-000996", "Aoshi Seito", 77500, 1], ["NIN-001449", "Aremi Roran", 77500, 1], ["NIN-001033", "Zaryu Rizaki", 77500, 1],
  ["NIN-001043", "Tushita Shabiri", 77500, 1], ["NIN-001192", "Shin Togarashi", 77500, 1], ["NIN-001358", "Seiran Tsukiyori", 77500, 1],
  ["NIN-001540", "Raiden Yukimura", 77500, 1], ["NIN-001537", "Miwa Sajin", 77500, 1], ["NIN-001417", "Kento Hakumei", 77500, 1],
  ["NIN-001182", "Izuma Shindra", 77500, 1], ["NIN-000827", "Haruki Sogen", 77500, 1], ["NIN-000811", "Daikiro Okuwa", 77500, 1],
  ["NIN-001455", "Kosa Sabaku", 74700, 1], ["NIN-001340", "sakizu yamato", 62000, 1], ["NIN-001260", "Yuto Kurosaki", 62000, 1],
  ["NIN-001359", "Tetsu Arashi", 62000, 1], ["NIN-001520", "Tomo Kazeru", 62000, 1], ["NIN-001536", "Shinra Sabaku", 62000, 1],
  ["NIN-001241", "Shin Ryomen", 62000, 1], ["NIN-001383", "Nobu Kiyoshi", 62000, 1], ["NIN-001290", "Kintoki Kushiki", 62000, 1],
  ["NIN-001325", "Kael Ren", 62000, 1], ["NIN-001381", "Junko Saki", 62000, 1], ["NIN-001170", "Haruto Tanaka", 62000, 1],
  ["NIN-001432", "Dondo Toko", 62000, 1], ["NIN-001555", "Nya Shirogane", 61480, 1], ["NIN-001334", "Shiro amakusa", 60400, 1],
  ["NIN-001035", "Nazuna Kazama", 60200, 1], ["NIN-001574", "Naoori Nagamoto", 57500, 1], ["NIN-001244", "Akito Hatsume", 57500, 1],
  ["NIN-001575", "Oma Denmon", 57000, 1], ["NIN-001332", "Kitsuki Kagomo", 52600, 1], ["NIN-001672", "Kinchaku Topo", 46500, 1],
  ["NIN-001794", "Tanzao Ito", 46500, 1], ["NIN-001793", "Garoo Kemuri", 46500, 1], ["NIN-001823", "Jayro Abarai", 46500, 1],
  ["NIN-001855", "Selma Obanai", 46500, 1], ["NIN-001854", "Hirashi Vonkai", 46500, 1], ["NIN-001822", "Ryu Shiru", 46500, 1],
  ["NIN-001853", "Ghano Komotsu", 46500, 1], ["NIN-001886", "Raizen Aketsu", 46500, 1], ["NIN-001820", "Seki Kazejin", 46500, 1],
  ["NIN-001707", "Rin Akashi", 46500, 1], ["NIN-001783", "Seya Derwoo", 46500, 1], ["NIN-001884", "Reika Kinomi", 46500, 1],
  ["NIN-001887", "Ryuta Chiiketsu", 46500, 1], ["NIN-001883", "Shin Sato", 46500, 1], ["NIN-001814", "Kido Shôta", 46500, 1],
  ["NIN-001813", "Yakuro .", 46500, 1], ["NIN-001538", "Shoppaï Saketsu", 46500, 1], ["NIN-001631", "Shôra Sabaku", 46500, 1],
  ["NIN-001748", "Shinra Illuk", 46500, 1], ["NIN-001606", "Shin Shuiku", 46500, 1], ["NIN-001355", "Saito Obara", 46500, 1],
  ["NIN-001009", "Haru Senkyo", 46500, 1], ["NIN-001832", "Renjiro Sairo", 46500, 1], ["NIN-001831", "Nayumi Sano", 46500, 1],
  ["NIN-001609", "Kobayashi Sora", 46500, 1], ["NIN-001509", "Kazeo Shiro", 46500, 1], ["NIN-001830", "Shô Râ Shihôin", 46500, 1],
  ["NIN-001802", "Raijin Kusanagi", 46500, 1], ["NIN-001300", "Kazama Tsubo", 46500, 1], ["NIN-001571", "Ishinn Sajin", 46500, 1],
  ["NIN-000864", "Jin Ringo", 46500, 1], ["NIN-001829", "Tairo Kajiya", 46500, 1], ["NIN-001547", "Taro Okuwa", 46500, 1],
  ["NIN-001795", "Seijuro Renjiro", 46500, 1], ["NIN-001744", "Kuren Kazama", 46390, 1], ["NIN-001804", "Sora Kanzaki", 42500, 1],
  ["NIN-001418", "Mouten Kuzushi", 41500, 1], ["NIN-001468", "Hikio Mizao", 40500, 1], ["NIN-001512", "Toshiro Makaze", 38630, 1],
  ["NIN-001824", "Ohara Shiru", 36500, 1], ["NIN-001660", "Akira Muzenchi", 31000, 1], ["NIN-001791", "Akijiu Ujiro", 31000, 1],
  ["NIN-001790", "Kazuha Kaderha", 31000, 1], ["NIN-001789", "Yuna Yamai", 31000, 1], ["NIN-001785", "Takumi Sunei", 31000, 1],
  ["NIN-001755", "Ren Akashi", 31000, 1], ["NIN-001882", "Hato Kuroi", 31000, 1], ["NIN-001781", "Ryuk Sato", 31000, 1],
  ["NIN-001751", "Hana Asakura", 31000, 1], ["NIN-001749", "Hina Asakura", 31000, 1], ["NIN-001874", "Ego Kenseki", 31000, 1],
  ["NIN-001810", "Shiden Kiyoshi", 31000, 1], ["NIN-001776", "Kazen Kana", 31000, 1], ["NIN-001616", "Saka Zetsubo", 31000, 1],
  ["NIN-001877", "Taito Arakawa", 31000, 1], ["NIN-001807", "Zao Ito", 31000, 1], ["NIN-001772", "Nizen Mukonn", 31000, 1],
  ["NIN-001876", "Doku Nezumi", 31000, 1], ["NIN-001806", "Kamiya Rei", 31000, 1], ["NIN-001868", "Shozen Kagame", 31000, 1],
  ["NIN-001769", "Saena Obanai", 31000, 1], ["NIN-001867", "Ren Kazehara", 31000, 1], ["NIN-001623", "Kizu Tenshi", 31000, 1],
  ["NIN-001767", "Ippo Jin", 31000, 1], ["NIN-001865", "Aizen Kagame", 31000, 1], ["NIN-001766", "Ken Yake", 31000, 1],
  ["NIN-001801", "Akane Kiyoshi", 31000, 1], ["NIN-001861", "Nezumi Doku", 31000, 1], ["NIN-001858", "Syn Mikazuchi", 31000, 1],
  ["NIN-001745", "Kaiji Akuro", 30890, 1], ["NIN-001402", "Yugi Kushiki", 50000, 1], ["NIN-000928", "Yuzo Aka", 50000, 1],
  ["NIN-001276", "Shiryu Kowasu", 50000, 1], ["NIN-001439", "Tak Kurotetsu", 50000, 1], ["NIN-001499", "Shenbaa Hakumei", 50000, 1],
  ["NIN-001839", "shiso Kiyoshi", 50000, 1], ["NIN-000808", "Yukio Sakimodo", 50000, 1], ["NIN-001242", "Naoki Yamazaki", 50000, 1],
  ["NIN-001395", "Kowé Heiki", 50000, 1], ["NIN-001285", "Ketsu Kokuyami", 50000, 1], ["NIN-001283", "Kenji Shiori", 50000, 1],
  ["NIN-001154", "Kenji Makuno", 50000, 1], ["NIN-001400", "Inao Hoki", 50000, 1], ["NIN-001528", "Kazuki Mitsuzen", 50000, 1],
  ["NIN-001630", "Sôka Shirogane", 45000, 1], ["NIN-001581", "Haruna agaku", 45000, 1], ["NIN-001740", "Shidai Ara", 45000, 1],
  ["NIN-001647", "Atsuki Hoki", 45000, 1], ["NIN-001570", "Perota akuro", 45000, 1], ["NIN-001732", "Ryô sabashiro", 40000, 1],
  ["NIN-001572", "Saya Fuyutsuki", 40000, 1], ["NIN-001612", "Saemi Hakumei", 40000, 1], ["NIN-001470", "Meguna Ichida", 40000, 1],
  ["NIN-001544", "Kagami Hoki", 40000, 1], ["NIN-001277", "Itoshi Kushiki", 40000, 1], ["NIN-001151", "Kaede Hayato", 40000, 1],
  ["NIN-001269", "Eiji Hime", 40000, 1], ["NIN-001739", "Daishi Ara", 40000, 1], ["NIN-001465", "Akito Fuyoshima", 40000, 1],
  ["NIN-001808", "Seishiro Kusanagi", 35000, 1], ["NIN-001583", "Chiro Akazuna", 35000, 1], ["NIN-001641", "Shion", 35000, 1],
  ["NIN-001746", "Senzai Akai", 35000, 1], ["NIN-001603", "Saku Zetsubo", 35000, 1], ["NIN-001825", "Sippi Saru", 35000, 1],
  ["NIN-001658", "rei arashi", 30000, 1], ["NIN-001657", "Seijuru Renjiru", 30000, 1], ["NIN-001856", "Muffetaro Genpachi", 30000, 1],
  ["NIN-001736", "Arashi Kaze", 30000, 1], ["NIN-001711", "Zhang Shan", 30000, 1], ["NIN-001594", "punpun Moki", 30000, 1],
  ["NIN-001852", "Kima Amiru", 30000, 1], ["NIN-001821", "Kai Kyo", 30000, 1], ["NIN-001708", "Akachi Taiju", 30000, 1],
  ["NIN-001728", "Uoo Azashin", 30000, 1], ["NIN-001815", "Kaisei Mikazuki", 30000, 1], ["NIN-001750", "Kyio Kamgemori", 30000, 1],
  ["NIN-001844", "Nishida Kyokaze", 30000, 1], ["NIN-001843", "Goto Kyokaze", 30000, 1], ["NIN-001721", "Eiji Denmon", 30000, 1],
  ["NIN-001805", "Yorito Mikazuchi", 30000, 1], ["NIN-001639", "Rayzo", 30000, 1], ["NIN-001504", "Natsuki Akari", 30000, 1],
  ["NIN-001624", "Jin Kido", 30000, 1], ["NIN-001326", "Hen Kurogane", 30000, 1], ["NIN-001828", "Juzo Kyokaze", 30000, 1],
  ["NIN-001691", "Zin Gah", 30000, 1], ["NIN-001645", "Dokai Sori", 30000, 1], ["NIN-001665", "Seijiru Renjiru", 30000, 1],
  ["NIN-001568", "Kazen Roran", 30000, 1], ["NIN-001563", "Aizen Kagetsu", 30000, 1], ["NIN-001689", "Itsuki Sato", 30000, 1],
  ["NIN-001379", "Yamada Shinjo", 30000, 1], ["NIN-001738", "HOBOUTO KATOKU", 30000, 1],
  ["NIN-001951", "DOKU TOGARASHI", 20000, 1], ["NIN-001931", "Rouslane Shu", 20000, 1], ["NIN-001666", "Kahal Bakkujin", 20000, 1],
  ["NIN-001902", "Eden Tobari", 20000, 1], ["NIN-001949", "Yuno Zenon", 20000, 1], ["NIN-001929", "Yokodori Sakai", 20000, 1],
  ["NIN-001901", "Arashi Tsukishima", 20000, 1], ["NIN-001889", "Suna. Chikatsume", 20000, 1], ["NIN-001759", "Richiro Kogane", 20000, 1],
  ["NIN-001900", "Seiya Tobari", 20000, 1], ["NIN-001758", "Tatsuo Tayra", 20000, 1], ["NIN-001764", "Jiro .", 20000, 1],
  ["NIN-001927", "Tetsuya Ryuji", 20000, 1], ["NIN-001709", "Sanka Malo", 20000, 1], ["NIN-001686", "Senjuro Isoshi", 20000, 1],
  ["NIN-001756", "Reva Kototsu", 20000, 1], ["NIN-001924", "Satoshi Retsu", 20000, 1], ["NIN-001897", "Brise écarlate", 20000, 1],
  ["NIN-001925", "Shinji Retsu", 20000, 1], ["NIN-001923", "Bokutsu Retsu", 20000, 1], ["NIN-001683", "Amira Seiki", 20000, 1],
  ["NIN-001848", "Brise Ardente", 20000, 1], ["NIN-001921", "Shaku Ohoha", 20000, 1], ["NIN-001705", "Akio Tsukasa", 20000, 1],
  ["NIN-001780", "Naoketsu Chiiketsu", 20000, 1], ["NIN-001959", "Kuru Katsuma", 20000, 1], ["NIN-001919", "Kurogane Mugen", 20000, 1],
  ["NIN-001680", "Tong Shan", 20000, 1], ["NIN-001779", "Reito Yamai", 20000, 1], ["NIN-001958", "Renjiro Kagemori", 20000, 1],
  ["NIN-001922", "Uno Raygame", 20000, 1], ["NIN-001918", "Kaido Kusanagi", 20000, 1], ["NIN-001895", "Kodo .", 20000, 1],
  ["NIN-001812", "Nagare Mitsuzen", 20000, 1], ["NIN-001845", "Byaku Ren", 20000, 1], ["NIN-001894", "Ryota Katsuro", 20000, 1],
  ["NIN-001916", "Rava Kototsu", 20000, 1], ["NIN-001678", "Kororo kornami", 20000, 1], ["NIN-001622", "Senda Ashashine", 20000, 1],
  ["NIN-001955", "Komada Chojuro", 20000, 1], ["NIN-001915", "Yuso Kenseki", 20000, 1], ["NIN-001914", "Kuma Itsuki", 20000, 1],
  ["NIN-001841", "Takumi Sunai", 20000, 1], ["NIN-001913", "Itsuki Hiroshi", 20000, 1], ["NIN-001771", "Mikey Ohoha", 20000, 1],
  ["NIN-001939", "Kino Yutsu", 20000, 1], ["NIN-001869", "Daisuke Matsuda", 20000, 1], ["NIN-001938", "Sann Yotei", 20000, 1],
  ["NIN-001743", "YMIR AKECHI", 20000, 1], ["NIN-001866", "Yorai Yuzuki", 20000, 1], ["NIN-001908", "Kanna Chikatsume", 20000, 1],
  ["NIN-001765", "Shiro Mitsuzen", 20000, 1], ["NIN-001864", "Shirokage Retsuga", 20000, 1], ["NIN-001422", "Gaiji Kinshiro", 20000, 1],
  ["NIN-001934", "Rina Togarashi", 20000, 1], ["NIN-001906", "Ren Aizawa", 20000, 1], ["NIN-001953", "Seiji Amatsuki", 20000, 1],
  ["NIN-001905", "Megumi .", 20000, 1], ["NIN-001834", "Izuna Mitsuzen", 20000, 1], ["NIN-001904", "Kaïba Tobari", 20000, 1],
  ["NIN-001935", "Toji Tsukihana", 20000, 1]
];

async function main() {
  if (await prisma.appSetting.findUnique({ where: { key: FLAG } })) { console.log("import-recouvrement : déjà appliqué"); return; }
  const [unknownGrade, systemUser, rpSetting] = await Promise.all([
    prisma.ninjaGrade.findUnique({ where: { code: "UNKNOWN" } }),
    prisma.user.findFirst({ where: { roles: { some: { role: { code: "SUPER_ADMIN" } } } }, orderBy: { createdAt: "asc" } }),
    prisma.appSetting.findUnique({ where: { key: "rpTime" } })
  ]);
  if (!unknownGrade || !systemUser) { console.log("import-recouvrement : référentiels absents — exécutez d'abord le bootstrap"); return; }
  const parsedRp = rpSetting ? rpTimeConfigSchema.safeParse(rpSetting.value) : null;
  const service = createRpTimeService(parsedRp?.success ? parsedRp.data : defaultRpTimeConfig);
  const currentRpYear = service.currentRpYear();

  const policy = await prisma.taxPolicy.upsert({
    where: { name_version: { name: "Ancien registre", version: 1 } },
    create: { name: "Ancien registre", version: 1, effectiveFromRpYear: 0, isActive: false },
    update: {}
  });

  let created = 0, skipped = 0;
  await prisma.$transaction(async (tx) => {
    const yearCache = new Map<number, string>();
    for (const [code, fullName, debt, yearsLate] of ROWS) {
      const existing = await tx.ninjaProfile.findUnique({ where: { code } });
      if (existing) { skipped++; continue; }
      const spaceIndex = fullName.indexOf(" ");
      const firstName = spaceIndex === -1 ? fullName : fullName.slice(0, spaceIndex);
      const lastName = spaceIndex === -1 ? fullName : fullName.slice(spaceIndex + 1);

      const profile = await tx.ninjaProfile.create({ data: { code, firstName, lastName, currentGradeId: unknownGrade.id, notes: "Reprise de la dette de l'ancien registre (migration Supabase, 13/09/2026) — grade réel à confirmer" } });
      await tx.ninjaGradeHistory.create({ data: { ninjaId: profile.id, gradeId: unknownGrade.id, effectiveFrom: new Date(), reason: "Import de l'ancien registre — grade à confirmer", changedById: systemUser.id } });

      const debtRpYear = currentRpYear - yearsLate;
      let yearId = yearCache.get(debtRpYear);
      if (!yearId) {
        const dueAt = service.dueAt(debtRpYear);
        const year = await tx.taxYear.upsert({
          where: { rpYear: debtRpYear },
          create: { rpYear: debtRpYear, taxPolicyId: policy.id, startsAt: service.startOfRpYear(debtRpYear), endsAt: service.endOfRpYear(debtRpYear), dueAt },
          update: {}
        });
        yearId = year.id;
        yearCache.set(debtRpYear, yearId);
      }
      const assessment = await tx.taxAssessment.create({ data: {
        ninjaId: profile.id, taxYearId: yearId, taxPolicyId: policy.id, gradeCodeSnapshot: "ANCIEN", gradeLabelSnapshot: "Ancien registre",
        originalAmount: 0n, dueAt: service.dueAt(debtRpYear), status: "OVERDUE"
      } });
      await tx.taxAdjustment.create({ data: {
        assessmentId: assessment.id, type: "EXCEPTIONAL_DEBT", amount: BigInt(debt),
        reason: "Reprise de la dette de l'ancien registre (migration Supabase, 13/09/2026)", createdById: systemUser.id
      } });
      created++;
    }
    await tx.appSetting.create({ data: { key: FLAG, value: { importedAt: new Date().toISOString(), created, skipped } } });
    await tx.auditLog.create({ data: { action: "LEGACY_RECOUVREMENT_IMPORT", entityType: "NinjaProfile", entityId: FLAG, requestId: randomUUID(), reason: `Reprise du recouvrement de l'ancien registre : ${created} fiches créées, ${skipped} déjà existantes` } });
  }, { timeout: 300_000, maxWait: 30_000 });
  console.log(`import-recouvrement : ${created} fiches créées, ${skipped} déjà présentes`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
