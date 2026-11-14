"use client";

import { useEffect, useState } from "react";

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function InstallApp() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [isIOS, setIsIOS] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const displayMode = window.matchMedia(
      "(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui), (display-mode: window-controls-overlay)",
    );
    const appleNavigator = navigator as Navigator & { standalone?: boolean };
    const updateDisplayMode = () => {
      setInstalled(displayMode.matches || appleNavigator.standalone === true);
    };
    const capturePrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPrompt);
      setError("");
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };

    updateDisplayMode();
    setIsIOS(
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    );
    window.addEventListener("beforeinstallprompt", capturePrompt);
    window.addEventListener("appinstalled", onInstalled);
    displayMode.addEventListener("change", updateDisplayMode);
    return () => {
      window.removeEventListener("beforeinstallprompt", capturePrompt);
      window.removeEventListener("appinstalled", onInstalled);
      displayMode.removeEventListener("change", updateDisplayMode);
    };
  }, []);

  async function install() {
    if (!installPrompt || busy) return;
    setBusy(true);
    setError("");
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") setInstalled(true);
    } catch {
      setError(
        "The install prompt could not open. Use your browser's install menu instead.",
      );
    } finally {
      // A browser install prompt can only be used once, even after dismissal.
      setInstallPrompt(null);
      setBusy(false);
    }
  }

  if (installed !== false) return null;

  return (
    <aside className="install-app" aria-label="App installation">
      <details>
        <summary>Install Webcards</summary>
        <p>
          Keep a little vocabulary on your home screen. Webcards opens in its
          own app window; it is not an offline copy.
        </p>
        {installPrompt ? (
          <button
            type="button"
            className="secondary-button"
            onClick={install}
            disabled={busy}
          >
            {busy ? "Opening install prompt..." : "Install app"}
          </button>
        ) : isIOS ? (
          <p>
            On iPhone or iPad, open this site in Safari, tap Share, then Add to
            Home Screen. If offered, leave Open as Web App enabled, then tap
            Add. Reopen the new Webcards icon while connected to the internet.
          </p>
        ) : (
          <p>
            In Chrome or Edge, use the address-bar install icon or the browser
            menu's Install app / Add to Home screen option. In Safari on Mac,
            choose File, then Add to Dock. If no install option appears, open
            this site in a supported browser rather than an in-app browser.
          </p>
        )}
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <p className="install-note">
          Internet required for sign-in, translation, vocabulary, and reviews.
          Updates arrive when you reload or reopen the app; no reinstall needed.
        </p>
      </details>
    </aside>
  );
}
