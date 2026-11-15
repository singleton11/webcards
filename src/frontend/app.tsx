import { useEffect, useState, type ReactNode } from "react";
import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router";
import { z } from "zod";
import { CardDetails } from "@/components/card-details";
import { DailyReview } from "@/components/daily-review";
import { InstallApp } from "@/components/install-app";
import { LoginForm } from "@/components/login-form";
import { Navigation } from "@/components/navigation";
import { Translator } from "@/components/translator";
import { VocabularyList } from "@/components/vocabulary-list";
import { CardRequestError, cardRequest } from "@/lib/card-client";
import type { Card } from "@/lib/card-contracts";

function SessionGate({
  children,
  login,
}: {
  children: ReactNode;
  login: boolean;
}) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void fetch("/api/session", {
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Session unavailable");
        const session: unknown = await response.json();
        if (
          !session ||
          typeof session !== "object" ||
          !("authenticated" in session) ||
          typeof session.authenticated !== "boolean"
        )
          throw new Error("Invalid session");
        if (!controller.signal.aborted) setAuthenticated(session.authenticated);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [retry]);
  if (error)
    return (
      <main className="coming-soon">
        <h1>Cannot reach Webcards.</h1>
        <p role="alert">Your session could not be checked. Please try again.</p>
        <button
          className="primary-button"
          onClick={() => setRetry((value) => value + 1)}
        >
          Retry connection
        </button>
      </main>
    );
  if (authenticated === null)
    return (
      <main className="coming-soon">
        <p role="status">Checking your session...</p>
      </main>
    );
  if (!authenticated && !login) return <Navigate to="/login" replace />;
  if (authenticated && login) return <Navigate to="/" replace />;
  return children;
}

function LoginPage() {
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

function Workspace() {
  return (
    <div className="app-shell">
      <Navigation />
      <Outlet />
      <InstallApp />
      <footer className="site-footer">
        <span>Small discoveries. Lasting vocabulary.</span>
        <span>RUSSIAN / ENGLISH</span>
      </footer>
    </div>
  );
}

function NotFound() {
  return (
    <main className="coming-soon">
      <h1>Page not found.</h1>
      <p>This page or card is no longer available.</p>
      <a className="primary-button" href="/list">
        Back to My list
      </a>
    </main>
  );
}

function CardPage() {
  const { id = "" } = useParams();
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState<CardRequestError | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!z.uuid().safeParse(id).success) {
      setError(new CardRequestError("Card not found.", 404));
      return;
    }
    const controller = new AbortController();
    setError(null);
    void cardRequest<{ card: Card }>(
      "/api/cards/" + encodeURIComponent(id),
      undefined,
      AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    )
      .then((result) => {
        if (!controller.signal.aborted) setCard(result.card);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error);
      });
    return () => controller.abort();
  }, [id, retry]);
  if (error?.status === 401) return <Navigate to="/login" replace />;
  if (error?.status === 404) return <NotFound />;
  if (error)
    return (
      <main className="coming-soon">
        <p role="alert">{error.message}</p>
        <button
          className="primary-button"
          onClick={() => setRetry((value) => value + 1)}
        >
          Retry loading card
        </button>
      </main>
    );
  if (!card)
    return (
      <main className="coming-soon">
        <p role="status">Loading your card...</p>
      </main>
    );
  return <CardDetails initialCard={card} />;
}

export function App() {
  const { pathname } = useLocation();
  const path = pathname.replace(/\/+$/, "") || "/";
  return (
    <SessionGate key={path} login={path === "/login"}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<Workspace />}>
          <Route path="/" element={<Translator />} />
          <Route path="/list" element={<VocabularyList />} />
          <Route path="/list/:id" element={<CardPage />} />
          <Route path="/today" element={<DailyReview />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </SessionGate>
  );
}
