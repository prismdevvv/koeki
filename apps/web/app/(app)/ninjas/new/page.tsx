import Link from "next/link";
import { ArrowLeft, UserPlus } from "lucide-react";
import { PageHeader, SectionHeader } from "@koeki/ui";
import { demoMode, requirePermission } from "@/lib/session";
import { createNinja } from "../actions";
import { prisma } from "@koeki/database";

export default async function NewNinjaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission("ninjas:write");
  const query = await searchParams;
  const grades = demoMode ? [] : await prisma.ninjaGrade.findMany({ where: { isActive: true, code: { not: "UNKNOWN" } }, orderBy: { sortOrder: "asc" } });
  const error = typeof query.erreur === "string" ? query.erreur : null;
  const firstName = typeof query.firstName === "string" ? query.firstName : "";
  const lastName = typeof query.lastName === "string" ? query.lastName : "";
  return <div className="page-wrap">
    <PageHeader eyebrow="Registre administratif" title="Nouveau ninja" description="Prénom, nom et grade sont obligatoires — le code administratif est attribué automatiquement."
      actions={<Link className="button button-ghost" href="/ninjas"><ArrowLeft size={17} /> Annuler</Link>} />
    {error && <p className="notice error" role="alert">{error}</p>}
    {demoMode ? <p className="notice" role="status">Mode démonstration : la création de dossier est désactivée.</p> : <section className="panel" style={{ maxWidth: 640 }}>
      <SectionHeader title="Dossier administratif" description="Les informations secondaires restent modifiables ensuite" />
      <form action={createNinja} className="form-grid">
        <div className="form-row">
          <label>Prénom *<input type="text" name="firstName" required maxLength={80} defaultValue={firstName} /></label>
          <label>Nom *<input type="text" name="lastName" required maxLength={80} defaultValue={lastName} /></label>
        </div>
        <div className="form-row">
          <label>Grade *<select name="gradeId" required defaultValue=""><option value="" disabled>Sélectionner un grade…</option>{grades.map((grade) => <option key={grade.id} value={grade.id}>{grade.label}</option>)}</select></label>
          <label>Pseudonyme<input type="text" name="alias" maxLength={80} /></label>
        </div>
        <label>Clan ou famille<input type="text" name="clan" maxLength={80} /></label>
        <label>Notes internes<textarea name="notes" maxLength={2000} placeholder="Visibles uniquement par le service économique…" /></label>
        <div className="form-actions"><button className="button button-primary" type="submit"><UserPlus size={16} /> Créer le dossier</button></div>
      </form>
    </section>}
  </div>;
}
