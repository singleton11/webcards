"use client";
import { useState, useRef, useEffect } from "react";
import type { TranslationResult } from "@/lib/contracts";
import { SaveTranslation } from "@/components/save-translation";
const names = { ru: "Russian", en: "English" };
class TranslationFailure extends Error {}
export function Translator() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [source, setSource] = useState<"ru" | "en">("en");
  const target = source === "ru" ? "en" : "ru";
  const [text, setText] = useState("");
  const [context, setContext] = useState("");
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resultRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  function clear() {
    requestIdRef.current = null;
    setResult(null);
    setError("");
  }
  function swap() {
    setSource(target);
    if (result?.alternatives[0])
      setText(result.alternatives[0].translation.slice(0, 500));
    clear();
  }
  async function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (!ready || sendingRef.current || !text.trim()) return;
    sendingRef.current = true;
    requestIdRef.current ??= crypto.randomUUID();
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: requestIdRef.current,
          source,
          target,
          text,
          context,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const body = await response.json();
      if (!response.ok)
        throw new TranslationFailure(
          body.error || "Translation failed. Your text is still here.",
        );
      setResult(body);
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (error) {
      setError(
        error instanceof TranslationFailure
          ? error.message
          : "Connection interrupted. Your text is still here; you can retry.",
      );
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="translate-page">
      <section className="intro">
        <div>
          <span className="eyebrow">
            <span className="green-dot" /> WORDS WITH A PURPOSE
          </span>
          <h1>
            Understand it now.
            <br />
            <em>Keep it for later.</em>
          </h1>
        </div>
        <p>
          A word, a phrase, a little context. <br />
          Start with something you actually need.
        </p>
      </section>
      <section className="translator-grid" aria-label="Translator">
        <form
          className="input-card"
          method="post"
          action="/api/translate"
          onSubmit={submit}
        >
          <div className="language-bar">
            <label className="language-select">
              <span className="sr-only">Source language</span>
              <select
                value={source}
                disabled={busy || !ready}
                onChange={(e) => {
                  setSource(e.target.value as "ru" | "en");
                  clear();
                }}
              >
                <option value="ru">Russian</option>
                <option value="en">English</option>
              </select>
            </label>
            <button
              type="button"
              className="swap-button"
              onClick={swap}
              disabled={busy || !ready}
              aria-label="Swap languages"
            >
              <span aria-hidden="true">⇄</span>
            </button>
            <span className="target-language">{names[target]}</span>
          </div>
          <label htmlFor="source-text" className="sr-only">
            Text to translate
          </label>
          <textarea
            id="source-text"
            lang={source}
            value={text}
            disabled={busy || !ready}
            maxLength={500}
            placeholder={
              source === "ru"
                ? "Введите слово или фразу..."
                : "Enter a word or phrase..."
            }
            onChange={(e) => {
              setText(e.target.value);
              clear();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            aria-describedby="character-count"
          />
          <div className="input-meta">
            <span>SHORT TEXT. REAL MEANING.</span>
            <span id="character-count">{text.length} / 500</span>
          </div>
          <div className="context-field">
            <label htmlFor="context">
              A little context <span>optional</span>
            </label>
            <input
              id="context"
              value={context}
              disabled={busy || !ready}
              maxLength={300}
              onChange={(e) => {
                setContext(e.target.value);
                clear();
              }}
              placeholder="e.g. a greeting or a river"
            />
          </div>
          <div className="submit-row">
            <span className="keyboard-hint">Ctrl / Cmd + Enter</span>
            <button
              className="primary-button"
              disabled={busy || !ready || !text.trim()}
            >
              {busy ? "Translating..." : "Translate"}
              <span aria-hidden="true">↗</span>
            </button>
          </div>
        </form>
        <div
          className={"result-card " + (result ? "has-result" : "")}
          aria-busy={busy}
        >
          <div className="result-topline">
            <span className="eyebrow">
              {result ? names[result.target].toUpperCase() : "THE OTHER SIDE"}
            </span>
            <span className="result-number" aria-hidden="true">
              02 /
            </span>
          </div>
          <div ref={resultRef} tabIndex={-1} className="result-content">
            {busy ? (
              <div role="status" className="result-empty">
                <span className="loading-mark" aria-hidden="true">
                  ...
                </span>
                <h2>
                  Finding the
                  <br />
                  right words.
                </h2>
                <p>Looking for meaning, not just a match.</p>
              </div>
            ) : error ? (
              <div role="alert" className="result-empty">
                <span className="status-label">NOT TRANSLATED</span>
                <h2>
                  A little
                  <br />
                  interruption.
                </h2>
                <p>{error}</p>
                <button
                  type="button"
                  className="light-button"
                  onClick={() => void submit()}
                >
                  Try again
                </button>
              </div>
            ) : result?.status === "needs_context" ? (
              <div className="result-empty">
                <span className="status-label">CONTEXT NEEDED</span>
                <h2>
                  Which meaning
                  <br />
                  did you mean?
                </h2>
                <p role="status">{result.clarification}</p>
                <p className="small-note">
                  Add a little context above the Translate button, then try
                  again.
                </p>
              </div>
            ) : result ? (
              <div>
                <p className="sr-only" role="status">
                  Translation ready. {names[result.source]} to{" "}
                  {names[result.target]}.
                </p>
                {result.alternatives.map((a, i) => (
                  <article className="translation-alternative" key={i}>
                    <span className="sense-label">
                      {String(i + 1).padStart(2, "0")} / {a.sense}
                    </span>
                    <h2 lang={result.target}>{a.translation}</h2>
                    {a.note && <p>{a.note}</p>}
                    <SaveTranslation
                      content={{
                        russian: result.source === "ru" ? text : a.translation,
                        english: result.source === "en" ? text : a.translation,
                        sense: a.sense,
                        context,
                        note: a.note,
                      }}
                      source={result.source}
                      model={result.model}
                      promptVersion={result.promptVersion}
                    />
                  </article>
                ))}
                <p className="small-note">
                  Only the meaning you choose is saved.
                </p>
              </div>
            ) : (
              <div className="result-empty">
                <span className="decorative-asterisk" aria-hidden="true">
                  ✳
                </span>
                <h2>
                  Every word
                  <br />
                  opens a door.
                </h2>
                <p>
                  Your translation will appear here.
                  <br />
                  One clear meaning at a time.
                </p>
              </div>
            )}
          </div>
          <div className="result-bottomline">
            <span>RUSSIAN + ENGLISH</span>
            <span>MEANING FIRST</span>
          </div>
        </div>
      </section>
      <aside className="privacy-note">
        <span aria-hidden="true">↗</span>
        <p>
          Only when you press Translate, your text and context go through
          LiteLLM to the configured OpenAI upstream. Provider retention is not
          yet verified: avoid sensitive text. Only cards you explicitly add are
          kept in My list; translations are not saved automatically. Translation
          needs an internet connection.
        </p>
      </aside>
    </main>
  );
}
