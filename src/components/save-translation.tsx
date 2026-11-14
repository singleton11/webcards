"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import type { CardResult, CardContent } from "@/lib/card-contracts";
import { cardRequest } from "@/lib/card-client";

export function SaveTranslation({
  content,
  source,
  model,
  promptVersion,
}: {
  content: CardContent;
  source: "ru" | "en";
  model: string;
  promptVersion: string;
}) {
  const [result, setResult] = useState<CardResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const saveId = useRef<string | null>(null);
  const undoId = useRef<string | null>(null);
  const sending = useRef(false);
  async function act(undo = false) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      saveId.current ??= crypto.randomUUID();
      if (undo && result) {
        undoId.current ??= crypto.randomUUID();
        await cardRequest<CardResult>("/api/cards/" + result.cardId, {
          requestId: undoId.current,
          action: "undo",
          revision: result.revision,
          saveRequestId: saveId.current,
        });
        setResult(null);
        saveId.current = null;
        undoId.current = null;
        setMessage("Save undone. Nothing was added to your list.");
      } else {
        const saved = await cardRequest<CardResult>("/api/cards", {
          requestId: saveId.current,
          content,
          source,
          model,
          promptVersion,
        });
        if (saved.card) setResult(saved);
        else {
          setResult(null);
          saveId.current = null;
          setMessage("That save was already removed. You can add it again.");
        }
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not confirm the save. Please retry.",
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="save-controls" aria-busy={busy}>
      {result?.card ? (
        <div className="saved-row">
          <span role="status">
            {result.card.status === "archived"
              ? "Saved (archived)"
              : result.outcome === "duplicate"
                ? "Already saved"
                : "Saved"}
          </span>
          <Link href={"/list/" + result.cardId}>View card</Link>
          {result.outcome === "created" && result.card.revision === 1 && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void act(true)}
            >
              {busy ? "Undoing..." : "Undo"}
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="light-button"
          disabled={busy}
          onClick={() => void act()}
        >
          {busy ? "Saving..." : "Add to my list"}
        </button>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="save-error">
          {error}
        </p>
      )}
    </div>
  );
}
