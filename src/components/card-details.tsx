"use client";
import { Link } from "react-router";
import { useRef, useState } from "react";
import type { Card, CardContent, CardResult } from "@/lib/card-contracts";
import { cardRequest } from "@/lib/card-client";

const fields: {
  key: keyof CardContent;
  label: string;
  max: number;
  lang?: string;
  required?: boolean;
}[] = [
  {
    key: "russian",
    label: "Russian side",
    max: 1000,
    lang: "ru",
    required: true,
  },
  {
    key: "english",
    label: "English side",
    max: 1000,
    lang: "en",
    required: true,
  },
  { key: "sense", label: "Meaning", max: 160, required: true },
  { key: "context", label: "Context", max: 300 },
  { key: "note", label: "Usage note", max: 300 },
];
export function CardDetails({ initialCard }: { initialCard: Card }) {
  const [card, setCard] = useState<Card | null>(initialCard);
  const [draft, setDraft] = useState(initialCard.content);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const sending = useRef(false);
  const pending = useRef<{ payload: string; requestId: string } | null>(null);
  async function change(
    action: "edit" | "archive" | "restore" | "delete" | "reset",
  ) {
    if (!card || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    const body = {
      action,
      revision: card.revision,
      ...(action === "edit" ? { content: draft } : {}),
    };
    const payload = JSON.stringify(body);
    if (pending.current?.payload !== payload)
      pending.current = { payload, requestId: crypto.randomUUID() };
    try {
      const result = await cardRequest<CardResult>("/api/cards/" + card.id, {
        ...body,
        requestId: pending.current.requestId,
      });
      setCard(result.card);
      pending.current = null;
      setConfirmDelete(false);
      setConfirmReset(false);
      if (result.card) setDraft(result.card.content);
      setEditing(false);
      setMessage(
        action === "edit"
          ? "Changes saved."
          : action === "archive"
            ? "Card archived."
            : action === "restore"
              ? "Card restored."
              : action === "reset"
                ? "Learning reset for both directions. Review history remains."
                : "Card deleted, including all saved content versions and reviews.",
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not confirm the change. Please retry.",
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function reload() {
    if (!card || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await cardRequest<{ card: Card }>("/api/cards/" + card.id);
      setCard(result.card);
      setDraft(result.card.content);
      pending.current = null;
      setEditing(false);
      setConfirmDelete(false);
      setMessage("Current card loaded.");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not load the card.",
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="card-page">
      <Link className="back-link" to="/list">
        Back to My list
      </Link>
      {!card ? (
        <section className="list-empty">
          <h1>Card deleted.</h1>
          <p role="status">{message || "This card is no longer available."}</p>
        </section>
      ) : (
        <>
          <section className="intro">
            <div>
              <span className="eyebrow">
                {card.status === "archived"
                  ? "ARCHIVED MEANING"
                  : "A MEANING WORTH KEEPING"}
              </span>
              <h1>
                Your words.
                <br />
                <em>Your context.</em>
              </h1>
            </div>
            <p>
              Content version {card.version}
              <br />
              Originally{" "}
              {card.source === "ru"
                ? "Russian to English"
                : "English to Russian"}
            </p>
          </section>
          {message && (
            <p role="status" className="success-banner">
              {message}
            </p>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <p>{error}</p>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void reload()}
              >
                Reload current card (discards edits)
              </button>
            </div>
          )}
          {editing ? (
            <form
              className="card-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void change("edit");
              }}
            >
              <p id="version-note" className="editor-note">
                Keep one meaning per card. Saving creates a new content version;
                earlier versions and review history remain until deletion.
                Learning schedules stay as they are; reset them if the meaning
                changed.
              </p>
              {fields.map((field) => (
                <div className="editor-field" key={field.key}>
                  <label htmlFor={"edit-" + field.key}>
                    {field.label}
                    {!field.required && <span> optional</span>}
                  </label>
                  <textarea
                    id={"edit-" + field.key}
                    lang={field.lang}
                    value={draft[field.key]}
                    maxLength={field.max}
                    required={field.required}
                    disabled={busy}
                    aria-describedby="version-note"
                    onChange={(event) =>
                      setDraft({ ...draft, [field.key]: event.target.value })
                    }
                  />
                </div>
              ))}
              <div className="card-actions">
                <button className="primary-button" disabled={busy}>
                  {busy ? "Saving..." : "Save changes"}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setDraft(card.content);
                    setError("");
                  }}
                >
                  Cancel editing
                </button>
              </div>
            </form>
          ) : (
            <section className="card-sheet" aria-label="Saved meaning">
              <div className="card-language-sides">
                <div>
                  <span className="eyebrow">RUSSIAN</span>
                  <h2 lang="ru">{card.content.russian}</h2>
                </div>
                <div>
                  <span className="eyebrow">ENGLISH</span>
                  <h2 lang="en">{card.content.english}</h2>
                </div>
              </div>
              <dl className="meaning-notes">
                <dt>Meaning</dt>
                <dd>{card.content.sense}</dd>
                {card.content.context && (
                  <>
                    <dt>Context</dt>
                    <dd>{card.content.context}</dd>
                  </>
                )}
                {card.content.note && (
                  <>
                    <dt>Usage note</dt>
                    <dd>{card.content.note}</dd>
                  </>
                )}
              </dl>
              <div className="card-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(true);
                    setError("");
                  }}
                >
                  Edit card
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    void change(
                      card.status === "active" ? "archive" : "restore",
                    )
                  }
                >
                  {card.status === "active" ? "Archive card" : "Restore card"}
                </button>
              </div>
            </section>
          )}
          <div className="card-provenance">
            Translation: {card.model} / {card.promptVersion}. Owner edits are
            stored as new versions, not new model translations.
          </div>
          {!editing && (
            <section className="delete-section" aria-label="Reset learning">
              {confirmReset ? (
                <>
                  <p>
                    Reset the review schedule for both directions? Previous
                    review history remains. This cannot be undone.
                  </p>
                  <div className="card-actions">
                    <button
                      type="button"
                      className="danger-button"
                      disabled={busy}
                      onClick={() => void change("reset")}
                    >
                      Confirm reset
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => setConfirmReset(false)}
                    >
                      Keep schedules
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => setConfirmReset(true)}
                >
                  Reset learning
                </button>
              )}
            </section>
          )}
          {!editing && (
            <section className="delete-section" aria-label="Delete card">
              {confirmDelete ? (
                <>
                  <p>
                    Delete this card and every content version permanently? This
                    cannot be undone. Archive it instead if you may want it
                    later.
                  </p>
                  <div className="card-actions">
                    <button
                      type="button"
                      className="danger-button"
                      disabled={busy}
                      onClick={() => void change("delete")}
                    >
                      Delete permanently
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => setConfirmDelete(false)}
                    >
                      Keep card
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete card
                </button>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
