"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
export function Navigation() {
  const path = usePathname();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error();
      window.location.replace("/login");
    } catch {
      setError("Could not sign out. Please try again.");
      setBusy(false);
    }
  }
  return (
    <>
      <header className="site-header">
        <Link className="wordmark" href="/" aria-label="Webcards home">
          <span className="brand-icon" aria-hidden="true">
            w.
          </span>
          webcards<span className="private-label">PERSONAL EDITION</span>
        </Link>
        <nav aria-label="Main navigation">
          {[
            ["/", "Translate"],
            ["/list", "My list"],
            ["/today", "Today"],
          ].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              aria-current={path === href ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
        <button
          className="text-button sign-out"
          disabled={busy}
          onClick={logout}
        >
          {busy ? "Signing out..." : "Sign out"}
        </button>
      </header>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
    </>
  );
}
