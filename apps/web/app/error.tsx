"use client";

import { useEffect } from "react";
import Link from "next/link";
import { EmptyState } from "@koeki/ui";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("[koeki] erreur applicative :", error); }, [error]);
  return <main className="standalone-state">
    <EmptyState title="Un problème est survenu" description="La page n’a pas pu se charger — souvent un service externe (Zenkai, Discord) momentanément indisponible. Réessayez dans un instant." />
    <div style={{ display: "flex", gap: 10 }}>
      <button className="button button-primary" type="button" onClick={() => reset()}>Réessayer</button>
      <Link href="/" className="button button-ghost">Retour à la salle des comptes</Link>
    </div>
  </main>;
}
