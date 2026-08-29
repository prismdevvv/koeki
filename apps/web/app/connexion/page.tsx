import { KeyRound, ShieldCheck } from "lucide-react";
import { signIn } from "@/auth";

export const metadata = { title: "Connexion" };

export default function SignInPage() {
  async function connect() { "use server"; await signIn("discord", { redirectTo: "/" }); }
  return <main className="invite-page">
    <section className="invite-card">
      <div className="brand-mark" aria-hidden="true"><span /></div>
      <p className="eyebrow">Service économique de Suna</p>
      <h1>KŌEKI</h1>
      <p>Registre des taxes, dons et ressources du village. Accès réservé aux shinobis de Suna.</p>
      <form action={connect}><button className="button button-primary" type="submit"><KeyRound size={17} /> Se connecter avec Discord</button></form>
      <p style={{ fontSize: 11 }}>L’accès est vérifié automatiquement via ton personnage Zenkai rattaché à Suna — aucune invitation n’est nécessaire pour consulter ta fiche.</p>
      <small><ShieldCheck size={14} /> Seuls les comptes liés à un personnage de Suna sont acceptés.</small>
      <div className="invite-dunes" aria-hidden="true"><i /><i /><i /></div>
    </section>
  </main>;
}
