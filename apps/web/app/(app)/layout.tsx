import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getShellInfo } from "@/lib/data";
import { demoMode, hasPermission, requireSession, type SessionInfo } from "@/lib/session";
import { prisma } from "@koeki/database";

function allowedNav(session: SessionInfo): string[] {
  const base = ["/", "/profil", "/ninjas", "/resources", "/dons", "/crafting", "/events"];
  if (hasPermission(session, "payments:write") || hasPermission(session, "audit:read")) base.push("/recouvrement", "/inventory", "/equipement", "/statistics");
  if (hasPermission(session, "reports:read")) base.push("/reports");
  if (hasPermission(session, "audit:read")) base.push("/audit");
  if (hasPermission(session, "users:manage") || hasPermission(session, "settings:manage")) base.push("/admin");
  return base;
}

export default async function PrivateLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  // Privacy requirement: every account must be linked to a ninja before using the register —
  // displayed identities are ninja names, never Discord account names.
  if (!demoMode) {
    const pathname = (await headers()).get("x-pathname") ?? "";
    if (!pathname.startsWith("/profil")) {
      const linked = await prisma.ninjaProfile.findUnique({ where: { userId: session.userId }, select: { id: true } });
      if (!linked) redirect("/profil");
    }
  }
  const shell = await getShellInfo(session);
  return <AppShell shell={shell} allowed={allowedNav(session)}>{children}</AppShell>;
}
