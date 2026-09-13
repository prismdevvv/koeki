"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BarChart3, BookOpenText, Boxes, ChevronLeft, ChevronRight, FileText, HandCoins, HeartHandshake,
  LayoutDashboard, LogOut, Menu, MessageCircleQuestion, PackageSearch, ScrollText, Settings, ShieldCheck, Trophy, UserCircle2, Users, X
} from "lucide-react";
import type { ShellInfo } from "@/lib/types";

const SUPPORT_DISCORD_URL = "https://discord.com/users/522551561591980073";

/* Navigation groupée par métier — les entrées gardent leurs routes historiques,
   seules celles autorisées par le layout serveur sont rendues. */
const navigation: Array<{ label: string | null; items: Array<{ href: string; label: string; icon: typeof LayoutDashboard }> }> = [
  { label: null, items: [{ href: "/", label: "Vue d’ensemble", icon: LayoutDashboard }] },
  { label: "Ninjas", items: [
    { href: "/profil", label: "Ma fiche", icon: UserCircle2 },
    { href: "/ninjas", label: "Ninjas", icon: Users },
    { href: "/recouvrement", label: "Recouvrement", icon: HandCoins }
  ] },
  { label: "Économie", items: [
    { href: "/resources", label: "Ressources", icon: PackageSearch },
    { href: "/dons", label: "Dons", icon: HeartHandshake },
    { href: "/inventory", label: "Inventaire", icon: Boxes },
    { href: "/crafting", label: "Artisanat", icon: BookOpenText },
    { href: "/equipement", label: "Équipement Jonin", icon: ShieldCheck }
  ] },
  { label: "Analyse", items: [
    { href: "/statistics", label: "Statistiques", icon: BarChart3 },
    { href: "/events", label: "Événements", icon: Trophy },
    { href: "/reports", label: "Rapports", icon: FileText }
  ] },
  { label: "Administration", items: [
    { href: "/audit", label: "Registre d’audit", icon: ScrollText },
    { href: "/admin", label: "Administration", icon: Settings }
  ] }
];

export function AppShell({ children, shell, allowed }: { children: React.ReactNode; shell: ShellInfo; allowed: string[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(localStorage.getItem("koeki.nav") === "collapsed"); }, []);
  const toggleCollapsed = () => setCollapsed((current) => { const next = !current; localStorage.setItem("koeki.nav", next ? "collapsed" : "expanded"); return next; });
  const groups = navigation.map((group) => ({ ...group, items: group.items.filter((item) => allowed.includes(item.href)) })).filter((group) => group.items.length > 0);
  return <div className={`app-shell${collapsed ? " nav-collapsed" : ""}`}>
    <a className="skip-link" href="#main">Aller au contenu</a>
    <button className="mobile-menu" onClick={() => setOpen(true)} aria-label="Ouvrir la navigation"><Menu /></button>
    {open && <button className="nav-backdrop" onClick={() => setOpen(false)} aria-label="Fermer la navigation" />}
    <aside className={`sidebar ${open ? "is-open" : ""}`}>
      <button className="nav-collapse" onClick={toggleCollapsed} aria-label={collapsed ? "Déplier la navigation" : "Replier la navigation"} title={collapsed ? "Déplier" : "Replier"}>
        {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>
      <div className="brand-row">
        <div className="brand-mark" aria-hidden="true"><span /></div>
        <div><div className="brand-name">KŌEKI</div><div className="brand-subtitle">Service économique</div></div>
        <button className="sidebar-close" onClick={() => setOpen(false)} aria-label="Fermer"><X /></button>
      </div>
      <div className="rp-clock" title={`Année RP ${shell.rpYear} · ${shell.rpDayLabel}`}><span>Année RP</span><strong>{shell.rpYear}</strong><small>{shell.rpDayLabel}</small><div><i style={{ width: `${Math.round(shell.rpProgress * 100)}%` }} /></div></div>
      <nav aria-label="Navigation principale">
        {groups.map((group, index) => <div key={group.label ?? index}>
          {group.label && <p className="nav-label">{group.label}</p>}
          {group.items.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return <Link key={href} href={href} className={active ? "active" : ""} title={label} onClick={() => setOpen(false)}>
              <Icon size={17} aria-hidden="true" /><span>{label}</span>
              {href === "/recouvrement" && shell.overdueCount > 0 && <b aria-label={`${shell.overdueCount} dossiers en retard`}>{shell.overdueCount}</b>}
            </Link>;
          })}
        </div>)}
      </nav>
      <div className="sidebar-footer">
        <a className="support-link" href={SUPPORT_DISCORD_URL} target="_blank" rel="noreferrer" title="Contacter Personne sur Discord">
          <span className="support-avatar"><MessageCircleQuestion size={16} aria-hidden="true" /></span>
          <span><strong>Un problème ?</strong><small>Contacter Personne sur Discord</small></span>
        </a>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- route handler (NextAuth signout), pas une page */}
        <a href="/api/auth/signout" title={`${shell.userName} — se déconnecter`}><span className="agent-avatar">{shell.userName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span><span><strong>{shell.userName}</strong><small>{shell.userRoleLabel}</small></span><LogOut size={16} aria-hidden="true" /></a>
        <div className="secure-line"><ShieldCheck size={14} /> Session sécurisée</div>
      </div>
    </aside>
    <main id="main" className="main-content">{children}</main>
  </div>;
}
