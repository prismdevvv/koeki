import { readFileSync, writeFileSync } from "node:fs";

const raw = readFileSync(new URL("./legacy-ninjas-raw.txt", import.meta.url), "utf8");
const blocks = raw.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

const GRADE_MAP = {
  "Non renseigné": "UNKNOWN", "Genin apprenti": "GENIN_APPRENTICE", "Genin simple": "GENIN",
  "Genin confirmé": "GENIN_CONFIRMED", "Chunin": "CHUNIN", "Konin": "KONIN",
  "Tokubetsu Jonin": "TOKUBETSU_JONIN", "Jonin": "JONIN", "Commandant Jonin": "JONIN_COMMANDER",
  "Kage": "KAGE", "Sanin": "SANIN"
};

const records = [];
const errors = [];
for (const block of blocks) {
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
  // lines: [initials, name, code(+alias), grade, "SITUATION\tdebt\tpoints pts\t—\tancienneté"]
  const code = lines.find((l) => /^NIN-\d{6}/.test(l));
  if (!code) { errors.push(block); continue; }
  const codeClean = code.match(/^NIN-\d{6}/)[0];
  const nameIndex = lines.findIndex((l) => /^NIN-\d{6}/.test(l)) - 1;
  const fullName = lines[nameIndex];
  const gradeLine = lines[lines.findIndex((l) => /^NIN-\d{6}/.test(l)) + 1];
  const dataLine = lines[lines.length - 1];
  const parts = dataLine.split("\t").map((p) => p.trim());
  if (parts.length < 5) { errors.push(block); continue; }
  const [situation, debtRaw, pointsRaw, , ancienneteRaw] = parts;
  const gradeCode = GRADE_MAP[gradeLine] ?? "UNKNOWN";
  const debtMatch = debtRaw.replace(/\s/g, "").match(/^([\d]+)Ryō$/);
  const debt = debtMatch ? Number(debtMatch[1]) : 0;
  const pointsMatch = pointsRaw.replace(/\s/g, "").match(/^(-?\d+)pts$/);
  const points = pointsMatch ? Number(pointsMatch[1]) : 0;
  const ansMatch = ancienneteRaw.match(/^(\d+)\s*an/);
  const yearsLate = ansMatch ? Number(ansMatch[1]) : 0;
  let status = "ACTIVE";
  if (situation === "DÉCÉDÉ") status = "DECEASED";
  else if (situation === "INACTIF") status = "INACTIVE";
  const spaceIndex = fullName.indexOf(" ");
  const firstName = spaceIndex === -1 ? fullName : fullName.slice(0, spaceIndex);
  const lastName = spaceIndex === -1 ? fullName : fullName.slice(spaceIndex + 1);
  records.push({ code: codeClean, firstName, lastName, gradeCode, status, situation, debt, points, yearsLate });
}

writeFileSync(new URL("./legacy-ninjas.json", import.meta.url), JSON.stringify(records, null, 2));
console.log(`Parsed ${records.length} records, ${errors.length} errors`);
if (errors.length) console.log("First error block:\n", errors[0]);
console.log("Sample:", records.slice(0, 3));
console.log("Grade distribution:", Object.fromEntries(Object.entries(records.reduce((acc, r) => { acc[r.gradeCode] = (acc[r.gradeCode] ?? 0) + 1; return acc; }, {}))));
console.log("Status distribution:", Object.fromEntries(Object.entries(records.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {}))));
