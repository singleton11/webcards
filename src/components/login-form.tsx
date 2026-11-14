"use client";
import { useState } from "react";
export function LoginForm() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/sign-in/username", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: data.get("username"),
          password: data.get("password"),
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        setError(
          response.status === 429
            ? "Too many attempts. Wait a minute before trying again."
            : "Sign-in failed. Check your username and password, then try again.",
        );
        return;
      }
      window.location.replace("/");
    } catch {
      setError("Cannot reach Webcards. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      method="post"
      action="/api/auth/sign-in/username"
      onSubmit={submit}
      className="login-form"
    >
      <label htmlFor="username">Username</label>
      <input
        id="username"
        name="username"
        autoComplete="username"
        required
        maxLength={30}
        autoCapitalize="none"
        spellCheck={false}
      />
      <label htmlFor="password">Password</label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        maxLength={128}
      />
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <button className="primary-button" disabled={busy}>
        {busy ? "Signing in..." : "Sign in"}
        <span aria-hidden="true"> /</span>
      </button>
      <p className="fine-print">Your private space. No public sign-ups.</p>
    </form>
  );
}
