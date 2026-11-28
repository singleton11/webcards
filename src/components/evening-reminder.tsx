import { useEffect, useState } from "react";

type Reminder = { time: string; timeZone: string };
type Settings = { publicKey: string | null; reminder: Reminder | null };

async function reminderRequest<T>(
  device: string | null,
  command?: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    "/api/reminders" + (device ? "?device=" + device : ""),
    {
      method: command ? "POST" : "GET",
      headers: command ? { "Content-Type": "application/json" } : undefined,
      body: command ? JSON.stringify(command) : undefined,
      signal: signal ?? AbortSignal.timeout(15000),
      cache: "no-store",
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "Could not load reminders.");
  return result;
}

async function deviceId(subscription: PushSubscription) {
  const data = new TextEncoder().encode(subscription.endpoint);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function EveningReminder() {
  const [opened, setOpened] = useState(false);
  const [time, setTime] = useState("19:00");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [registration, setRegistration] =
    useState<ServiceWorkerRegistration | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const supported =
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  useEffect(() => {
    if (!opened || !supported) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    setError("");
    setSettings(null);
    void (async () => {
      const currentWorker = await navigator.serviceWorker.getRegistration("/");
      const currentSubscription =
        (await currentWorker?.pushManager.getSubscription()) ?? null;
      const config = await reminderRequest<Settings>(
        currentSubscription ? await deviceId(currentSubscription) : null,
        undefined,
        signal,
      );
      if (config.publicKey) {
        const unavailable = new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        signal.throwIfAborted();
        const worker = await Promise.race([
          navigator.serviceWorker
            .register("/reminder-worker.js")
            .then(() => navigator.serviceWorker.ready),
          unavailable,
        ]);
        signal.throwIfAborted();
        setRegistration(worker);
      }
      setSettings(config);
      setSubscription(currentSubscription);
      setTime(config.reminder?.time ?? "19:00");
    })().catch(() => {
      if (!controller.signal.aborted)
        setError("Could not load evening reminders. Please try again.");
    });
    return () => controller.abort();
  }, [opened, retry, supported]);

  async function save(enable: boolean) {
    if (busy || !settings) return;
    setBusy(true);
    setError("");
    try {
      let current = subscription;
      if (enable && !current) {
        if (!registration || !settings.publicKey) return;
        current = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: settings.publicKey,
        });
        setSubscription(current);
      }
      if (!current)
        throw new Error("This browser’s push subscription is missing.");
      const result = await reminderRequest<Pick<Settings, "reminder">>(
        await deviceId(current),
        enable
          ? {
              action: "enable",
              time,
              timeZone: zone,
              subscription: current.toJSON(),
            }
          : { action: "disable" },
      );
      setSettings({ ...settings, reminder: result.reminder });
    } catch (cause) {
      setError(
        Notification.permission === "denied" && enable
          ? "Allow notifications for Webcards in your browser or device settings, then try again."
          : cause instanceof DOMException
            ? "Could not subscribe to notifications on this browser. Please try again."
            : cause instanceof Error
              ? cause.message
              : "Could not save your reminder.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <details
      className="evening-reminder"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary>Evening reminder</summary>
      {!supported ? (
        <p>
          Push notifications are unavailable here. On iPhone or iPad, add
          Webcards to your Home Screen and open it from there.
        </p>
      ) : (
        <>
          {error && <p role="alert">{error}</p>}
          {settings ? (
            <>
              {settings.reminder && settings.publicKey && (
                <p role="status">Reminder is on for this browser.</p>
              )}
              {settings.publicKey ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(true);
                  }}
                >
                  <label>
                    Reminder time
                    <input
                      type="time"
                      value={time}
                      onChange={(event) => setTime(event.target.value)}
                      required
                    />
                  </label>
                  <span>{zone.replaceAll("_", " ")}</span>
                  <button
                    className="secondary-button"
                    disabled={
                      !registration ||
                      busy ||
                      (settings.reminder?.time === time &&
                        settings.reminder.timeZone === zone)
                    }
                  >
                    {settings.reminder ? "Save time" : "Enable reminder"}
                  </button>
                </form>
              ) : (
                <p>Evening reminders are temporarily unavailable.</p>
              )}
              {settings.reminder && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void save(false)}
                >
                  Turn off reminder
                </button>
              )}
            </>
          ) : error ? (
            <button
              className="secondary-button"
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry
            </button>
          ) : (
            opened && <p role="status">Loading reminder settings…</p>
          )}
        </>
      )}
    </details>
  );
}
