import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ownerSession } from "@/lib/auth";
import { Navigation } from "@/components/navigation";
import { InstallApp } from "@/components/install-app";
export const dynamic = "force-dynamic";
export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await ownerSession(await headers());
  if (!session) redirect("/login");
  return (
    <div className="app-shell">
      <Navigation />
      {children}
      <InstallApp />
      <footer className="site-footer">
        <span>Small discoveries. Lasting vocabulary.</span>
        <span>RUSSIAN / ENGLISH</span>
      </footer>
    </div>
  );
}
