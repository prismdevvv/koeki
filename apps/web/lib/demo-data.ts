import type {
  ActiveRosterData, AdminData, AuditData, CraftingData, DashboardData, EventsData, InventoryData, NinjaDetailData, NinjaRow, NinjasData,
  RecoveryData, ReportsData, ResourcesData, ShellInfo, StatisticsData
} from "./types";

export const demoShell: ShellInfo = { rpYear: 48, rpDayLabel: "Mois RP 3 sur 7", rpProgress: 0.43, overdueCount: 12, userName: "Sonemi Hakumei", userRoleLabel: "Responsable Kōeki" };

const ninjaRows: NinjaRow[] = [
  { id: "demo-41", code: "NIN-000041", name: "Aoki Hoki", alias: "La Cigale", grade: "Chunin", points: 2440, debt: 0n, badge: "paid", statusLabel: "À jour", agent: "Sonemi H.", due: "—" },
  { id: "demo-58", code: "NIN-000058", name: "Araki Hoki", alias: null, grade: "Jonin", points: 2000, debt: 32000n, badge: "overdue", statusLabel: "En retard", agent: "Sonemi H.", due: "2 ans RP" },
  { id: "demo-63", code: "NIN-000063", name: "Inao Hoki", alias: "Sirocco", grade: "Genin confirmé", points: 500, debt: 0n, badge: "paid", statusLabel: "À jour", agent: "Kaemon T.", due: "—" },
  { id: "demo-72", code: "NIN-000072", name: "Izen Hoki", alias: null, grade: "Tokubetsu Jonin", points: 1290, debt: 8000n, badge: "due", statusLabel: "À payer", agent: "Kaemon T.", due: "4 jours" },
  { id: "demo-87", code: "NIN-000087", name: "Kagami Hoki", alias: "L’Œil du désert", grade: "Konin", points: 0, debt: 27000n, badge: "overdue", statusLabel: "En retard", agent: "Sonemi H.", due: "2 ans RP" },
  { id: "demo-94", code: "NIN-000094", name: "Tao Hoki", alias: null, grade: "Jonin", points: 2000, debt: 56000n, badge: "overdue", statusLabel: "En retard", agent: "Kaemon T.", due: "4 ans RP" },
  { id: "demo-109", code: "NIN-000109", name: "Yukiro Hoki", alias: null, grade: "Chunin", points: 860, debt: 15000n, badge: "warning", statusLabel: "Échéance proche", agent: "Sonemi H.", due: "1 jour" },
  { id: "demo-118", code: "NIN-000118", name: "Ren Kaze", alias: "Le Veilleur", grade: "Jonin", points: 1740, debt: 0n, badge: "draft", statusLabel: "Décédé", agent: "Kaemon T.", due: "—" }
];

export const demoDashboard: DashboardData = {
  rpYear: 48, expected: 401000n, collected: 214500n, exempted: 72000n, debt: 143000n, buybacks: 67400n, buybackCount: 23, stockValue: 418200n, criticalCount: 3, overdueNinjas: 12,
  recoveryRateBps: 7140, previousDeltaBps: 210,
  recoveryByYear: [{ rpYear: 44, percent: 82 }, { rpYear: 45, percent: 76 }, { rpYear: 46, percent: 88 }, { rpYear: 47, percent: 69 }, { rpYear: 48, percent: 71 }],
  priorities: { penaltyRateMissing: true, gradesToUpdate: 0, overdueCount: 12, overdueOldCount: 4, criticalStocks: ["Cuivre", "tissu renforcé", "bois d’aulne"], reportsToReview: 2 },
  activity: [
    { code: "PAY-2026-000184", label: "Paiement de taxe", subject: "Aoki Hoki", ninjaId: "demo-41", amount: 15000n, direction: "in", at: "Il y a 18 min", statusLabel: "Validée", status: "paid" },
    { code: "BUY-2026-000067", label: "Rachat de ressources", subject: "Mina Sabaku", ninjaId: "demo-58", amount: 8400n, direction: "out", at: "Il y a 42 min", statusLabel: "Validée", status: "paid" },
    { code: "DON-2026-000031", label: "Don enregistré", subject: "Sora Kaze", ninjaId: "demo-63", amount: 4200n, direction: "in", at: "Il y a 1 h", statusLabel: "Validée", status: "paid" },
    { code: "ADJ-2026-000012", label: "Remise validée", subject: "Izen Hoki", ninjaId: "demo-72", amount: 2000n, direction: "out", at: "Il y a 2 h", statusLabel: "Validée", status: "paid" }
  ]
};

export const demoNinjas: NinjasData = {
  summaryLine: "8 dossiers fictifs · 3 à jour · 3 en retard · 1 décédé · 138 000 Ryō dus",
  stats: { total: 8, upToDate: 3, needsUpdate: 0, overdue: 3, deceased: 1, debt: 138000n },
  grades: [{ code: "CHUNIN", label: "Chunin" }, { code: "JONIN", label: "Jonin" }, { code: "KONIN", label: "Konin" }],
  ninjas: ninjaRows, total: 8, page: 1, pageCount: 1
};

export const demoNinjaDetail: NinjaDetailData = {
  id: "demo-58", code: "NIN-000058", name: "Araki Hoki", alias: null, clan: "Hoki", lifecycleStatus: "ACTIVE", statusLabel: "Actif", diedAt: null,
  grade: { code: "JONIN", label: "Jonin" }, grades: [{ id: "g1", code: "JONIN", label: "Jonin" }],
  hasLinkedUser: false, notes: null, totalDebt: 32000n, lateYears: 2, nextDue: "Dépassée", pointsBalance: 2000, exemptionBalance: 12400n, exemptionGranted: 20400n, exemptionUsed: 8000n,
  assessments: [
    { id: "a47", rpYear: 47, period: "du 21/07 au 27/07", gradeLabel: "Jonin", original: 25000n, penalties: 0n, adjustments: 0n, exemptions: 0n, paid: 18000n, remaining: 7000n, statusLabel: "En retard", badge: "overdue", dueAt: "—" },
    { id: "a46", rpYear: 46, period: "du 14/07 au 20/07", gradeLabel: "Jonin", original: 25000n, penalties: 0n, adjustments: 0n, exemptions: 0n, paid: 0n, remaining: 25000n, statusLabel: "En retard", badge: "overdue", dueAt: "—" }
  ],
  pointEntries: [{ id: "p1", at: "12 juil.", label: "Paiement de taxe", points: 150, reason: null }],
  operations: [{ id: "o1", receipt: "PAY-2026-000112", label: "Paiement de taxe", amount: 18000n, at: "12 juil.", statusLabel: "Validée", badge: "paid" }],
  preview: null
};

export const demoRecovery: RecoveryData = {
  metrics: { priorityDebt: 115000n, priorityCount: 3, averageLate: "2,7 ans RP", totalDebt: 143000n, unassigned: 2 },
  rows: ninjaRows.filter((ninja) => ninja.badge === "overdue").map((ninja) => ({ id: ninja.id, name: ninja.name, code: ninja.code, debt: ninja.debt, legacyWeeks: 0, due: ninja.due, agent: ninja.agent, lastContactedAt: null }))
};

export const demoActiveRoster: ActiveRosterData = {
  metrics: { total: ninjaRows.length, unpaid: ninjaRows.filter((ninja) => ninja.badge === "overdue" || ninja.badge === "due").length, noFile: 0 },
  rows: ninjaRows.map((ninja) => ({ name: ninja.name, rank: ninja.grade, hasFile: true, ninjaId: ninja.id, code: ninja.code, debt: ninja.debt, badge: ninja.badge, statusLabel: ninja.statusLabel, lastPlayedAt: "Aujourd’hui" }))
};

export const demoResources: ResourcesData = {
  metrics: { buybackTotal: 67400n, buybackCount: 23, donationValue: 22400n, donationCount: 9, activeCount: 42, totalCount: 48 },
  categories: [{ code: "MINERALS", label: "Minerais" }, { code: "TEXTILES", label: "Textiles" }, { code: "WOOD", label: "Bois" }],
  resources: [
    { id: "r1", code: "RES-CUI-01", name: "Minerai de cuivre", category: "Minerais", points: 10, exemption: 1000n, price: 180n, stock: 82, badge: "paid", stateLabel: "Disponible", demand: "NONE" },
    { id: "r2", code: "RES-TIS-03", name: "Tissu renforcé", category: "Textiles", points: 10, exemption: 1000n, price: 320n, stock: 9, badge: "overdue", stateLabel: "Critique", demand: "NEEDED" },
    { id: "r3", code: "RES-BOI-02", name: "Bois d’aulne", category: "Bois", points: 5, exemption: 800n, price: 95n, stock: 14, badge: "warning", stateLabel: "Stock bas", demand: "CRITICAL" },
    { id: "r4", code: "RES-HER-08", name: "Herbe du désert", category: "Herboristerie", points: 2, exemption: 10n, price: 60n, stock: 143, badge: "paid", stateLabel: "Disponible", demand: "NONE" }
  ],
  pendingApprovals: []
};

export const demoInventory: InventoryData = {
  metrics: { stockValue: 418200n, movementsToday: 18, inToday: 12, outToday: 6, criticalCount: 3, lowCount: 1 },
  alerts: [
    { id: "r2", name: "Tissu renforcé", stock: 9, level: "critical", threshold: 12 },
    { id: "r3", name: "Bois d’aulne", stock: 14, level: "low", threshold: 20 },
    { id: "r5", name: "Sable siliceux", stock: 4, level: "critical", threshold: 8 }
  ],
  movements: [
    { id: "m1", at: "13:12", resource: "Minerai de cuivre", type: "Rachat", quantity: 12, agent: "Sonemi H.", justification: "BUY-2026-000067" },
    { id: "m2", at: "11:47", resource: "Tissu renforcé", type: "Consommation atelier", quantity: -3, agent: "Kaemon T.", justification: "Fabrication REC-ARM-014" }
  ],
  resources: [{ id: "r1", name: "Minerai de cuivre", stock: 82 }, { id: "r2", name: "Tissu renforcé", stock: 9 }]
};

export const demoCrafting: CraftingData = {
  metrics: { activeCount: 31, categoryCount: 7, craftableCount: 19, limitedCount: 3, executions: 12 },
  categories: ["Armurerie", "Médecine", "Outillage"],
  names: ["Plaque d’avant-bras renforcée", "Trousse d’outils de terrain", "Kit de soin du désert"],
  recipes: [
    { id: "c1", code: "REC-ARM-014", name: "Plaque d’avant-bras renforcée", category: "Armurerie", minimumGrade: "Chunin", cost: 6800n, craftable: 7, ingredients: [{ name: "Fer", quantity: 2 }, { name: "Cuir tanné", quantity: 1 }], output: "Plaque d’avant-bras", duration: "3 h RP", version: 3 },
    { id: "c2", code: "REC-OUT-006", name: "Trousse d’outils de terrain", category: "Outillage", minimumGrade: "Genin confirmé", cost: 2400n, craftable: 18, ingredients: [{ name: "Bois", quantity: 4 }, { name: "Cuivre", quantity: 2 }], output: null, duration: "90 min RP", version: 3 },
    { id: "c3", code: "REC-MED-021", name: "Kit de soin du désert", category: "Médecine", minimumGrade: "Chunin", cost: 3100n, craftable: 4, ingredients: [{ name: "Lavande", quantity: 6 }, { name: "Plastique", quantity: 2 }], output: null, duration: "2 h RP", version: 3 }
  ]
};

export const demoStatistics: StatisticsData = {
  rpYear: 48, expected: 401000n, collected: 214500n, exempted: 72000n, remaining: 114500n, rateBps: 7140, previousDeltaBps: 210,
  debtByGrade: [
    { grade: "Genin confirmé", amount: 18000n, percent: 22 }, { grade: "Chunin", amount: 35000n, percent: 42 }, { grade: "Konin", amount: 27000n, percent: 33 },
    { grade: "Jonin", amount: 56000n, percent: 68 }, { grade: "Tokubetsu", amount: 8000n, percent: 10 }
  ],
  agents: [
    { name: "Sonemi Hakumei", initials: "SH", payments: 19, collected: 112800n, donations: 5, buybacks: 2, transactions: 7, score: 91 },
    { name: "Kaemon Tori", initials: "KT", payments: 14, collected: 86400n, donations: 6, buybacks: 3, transactions: 9, score: 88 }
  ],
  topResources: [{ name: "Minerai de cuivre", typeLabel: "Rachat", quantity: 64 }, { name: "Herbe du désert", typeLabel: "Don", quantity: 31 }],
  topNinjas: [
    { id: "demo-1424", name: "Medo Nimto", code: "NIN-001424", points: 625 }, { id: "demo-1388", name: "Toshiro Makaze", code: "NIN-001388", points: 410 },
    { id: "demo-41", name: "Aoki Hoki", code: "NIN-000041", points: 260 }
  ],
  weekCompliance: { settled: 148, pending: 39, overdue: 23, total: 210, settledRateBps: 7047 },
  exemptionFlow: { granted: 842000n, spent: 316000n, outstanding: 1928000n },
  pointsDistributed: 12480
};

export const demoEvents: EventsData = {
  metrics: { open: 1, finished: 2, totalPrize: 150000n, participants: 131 },
  events: [
    { id: "ev1", name: "Tournoi Lavande", kindLabel: "Tournoi", statusLabel: "Terminé", badge: "paid", period: "20 — 29 juil.", resourceFocus: "Lavande", prize: 50000n, rewardPoints: 500, participants: 15, winnerId: "demo-41", winner: "Doma Nua", isOpen: false },
    { id: "ev2", name: "Tournoi récolte #1", kindLabel: "Tournoi", statusLabel: "Terminé", badge: "paid", period: "04 — 13 juil.", resourceFocus: "Toutes (hors Ryō)", prize: 100000n, rewardPoints: 1000, participants: 116, winnerId: "demo-58", winner: "Kagemoto Shuni", isOpen: false }
  ]
};

export const demoReports: ReportsData = {
  metrics: { toReview: 2, approved: 6, covered: 84, processed: 347500n, corrections: 3 },
  reports: [
    { id: "rep1", period: "28 juil. — 3 août", agent: "Kaemon Tori", payments: 14, donationBuybacks: "9", processed: 86400n, statusLabel: "Soumis", badge: "pending", canReview: false, canEdit: false, createdAt: "3 août · 18:20", summary: "Activité régulière au comptoir et clôture de la période sans écart de caisse.", incidents: null, stockIssues: "Stock de cuivre à surveiller.", followUps: "Contrôler le réassort lors de la prochaine permanence." },
    { id: "rep2", period: "28 juil. — 3 août", agent: "Sonemi Hakumei", payments: 19, donationBuybacks: "7", processed: 112800n, statusLabel: "Soumis", badge: "pending", canReview: false, canEdit: false, createdAt: "3 août · 17:45", summary: "Les opérations de la semaine ont été rapprochées avec le registre.", incidents: "Une correction de paiement a été enregistrée.", stockIssues: null, followUps: null },
    { id: "rep3", period: "21 — 27 juillet", agent: "Kaemon Tori", payments: 17, donationBuybacks: "8", processed: 94200n, statusLabel: "Approuvé", badge: "paid", canReview: false, canEdit: false, createdAt: "27 juillet · 19:05", summary: "Période clôturée et approuvée sans action complémentaire.", incidents: null, stockIssues: null, followUps: null }
  ],
  authors: [{ id: "demo-kaemon", name: "Kaemon Tori" }, { id: "demo-sonemi", name: "Sonemi Hakumei" }],
  total: 3, page: 1, pageCount: 1
};

export const demoAudit: AuditData = {
  rows: [
    { id: "au1", at: "04 août · 13:18", actor: "Sonemi Hakumei", action: "PAYMENT_CREATED", entity: "PAY-2026-000184", summary: "Paiement de 15 000 Ryō enregistré" },
    { id: "au2", at: "04 août · 12:54", actor: "Kaemon Tori", action: "BUYBACK_VALIDATED", entity: "BUY-2026-000067", summary: "Rachat validé après recalcul serveur" },
    { id: "au3", at: "04 août · 11:42", actor: "Sonemi Hakumei", action: "TAX_ADJUSTED", entity: "ADJ-2026-000012", summary: "Remise partielle — erreur administrative" },
    { id: "au4", at: "04 août · 10:03", actor: "Système", action: "INVENTORY_ALERT", entity: "RES-TIS-03", summary: "Seuil critique atteint" }
  ],
  actors: [{ id: "u1", name: "Sonemi Hakumei" }], total: 4, page: 1, pageCount: 1
};

export const demoAdmin: AdminData = {
  penalty: { percentBps: null, isValidated: false, isEnabled: false, basis: "ORIGINAL_TAX", maxApplications: 4, maxDebt: "32000" },
  gradeRates: [],
  currentWeek: { rpYear: 48, period: "du 03 août au 09 août", lines: 7, billable: 5, activeNinjas: 7, gradesToUpdate: 0 },
  approval: { amount: "50000", isValidated: false },
  exemption: { weeklyTaxCoverageBps: 0 },
  policy: { name: "Barème initial", version: 1, rateCount: 10 },
  rpTimeLabel: "1 semaine réelle = 1 année RP",
  invitations: [
    { id: "inv1", role: "Agent économique", ninja: null, statusLabel: "En attente", badge: "pending", createdAt: "02 août", expiresAt: "09 août", canRevoke: true },
    { id: "inv2", role: "Ninja", ninja: "NIN-000063", statusLabel: "Utilisée", badge: "paid", createdAt: "28 juil.", expiresAt: "04 août", canRevoke: false }
  ],
  users: [{ id: "u1", name: "Sonemi Hakumei", roles: "Responsable Kōeki", roleCodes: ["KOEKI_MANAGER"], revoked: false }],
  roles: [
    { id: "role1", code: "SUPER_ADMIN", label: "Super-administrateur" }, { id: "role2", code: "KOEKI_MANAGER", label: "Responsable Kōeki" },
    { id: "role3", code: "ECONOMIC_AGENT", label: "Agent économique" }, { id: "role4", code: "NINJA", label: "Ninja" }, { id: "role5", code: "AUDITOR", label: "Auditeur" }
  ],
  freeNinjas: [{ id: "demo-41", code: "NIN-000041", name: "Aoki Hoki" }]
};
