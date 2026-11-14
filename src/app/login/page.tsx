import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ownerSession } from "@/lib/auth";
import { LoginForm } from "@/components/login-form";
import { InstallApp } from "@/components/install-app";
export const dynamic = "force-dynamic";
export default async function LoginPage() {
  if (await ownerSession(await headers())) redirect("/");
  return (
    <main className="login-shell">
      <a href="/" className="wordmark">
        <span className="brand-icon" aria-hidden="true">
          w.
        </span>
        webcards
      </a>
      <div className="login-card">
        <span className="eyebrow">WELCOME BACK</span>
        <h1>
          A word today.
          <br />
          <em>Yours tomorrow.</em>
        </h1>
        <p className="login-intro">Translate what matters. Make it yours.</p>
        <LoginForm />
        <InstallApp />
      </div>
      <span className="login-footer">
        A PERSONAL RUSSIAN / ENGLISH COMPANION
      </span>
    </main>
  );
}
