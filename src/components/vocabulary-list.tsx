"use client";
import { Link } from "react-router";
import { useEffect, useState } from "react";
import { cardRequest } from "@/lib/card-client";
import type { CardList } from "@/lib/card-contracts";

export function VocabularyList() {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<CardList | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError("");
    const params = new URLSearchParams({
      q: query,
      status,
      page: String(page),
    });
    void cardRequest<CardList>(
      "/api/cards?" + params,
      undefined,
      AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    )
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "Could not load your list.",
          );
      });
    return () => controller.abort();
  }, [query, status, page, refresh]);
  return (
    <main className="vocabulary-page">
      <section className="intro">
        <div>
          <span className="eyebrow">
            <span className="green-dot" /> YOUR VOCABULARY
          </span>
          <h1>
            Small discoveries.
            <br />
            <em>Yours to keep.</em>
          </h1>
        </div>
        <p>
          One meaning at a time.
          <br /> A personal collection, not a translation history.
        </p>
      </section>
      <div className="list-toolbar">
        <form
          className="list-search"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(draft.trim());
            setPage(1);
            setRefresh((r) => r + 1);
          }}
        >
          <label htmlFor="vocabulary-search" className="sr-only">
            Search vocabulary
          </label>
          <input
            id="vocabulary-search"
            type="search"
            maxLength={100}
            placeholder="Find a word, meaning or context"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="primary-button">Search</button>
        </form>
        <div className="list-filters" aria-label="Card status">
          {(["active", "archived"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={status === value}
              onClick={() => {
                setStatus(value);
                setPage(1);
              }}
            >
              {value === "active" ? "Active" : "Archived"}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <div className="error-banner" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="text-button"
            onClick={() => setRefresh((r) => r + 1)}
          >
            Retry loading
          </button>
        </div>
      ) : !data ? (
        <p role="status" className="list-summary">
          Loading your vocabulary...
        </p>
      ) : (
        <section aria-label="Saved vocabulary">
          <p role="status" className="list-summary">
            {data.total} {status} {data.total === 1 ? "card" : "cards"}
            {query ? " matching your search" : ""}
          </p>
          {data.cards.length ? (
            <div className="vocabulary-grid">
              {data.cards.map((card) => (
                <article className="vocabulary-card" key={card.id}>
                  <span className="eyebrow">{card.content.sense}</span>
                  <h2 lang="en">
                    <Link to={"/list/" + card.id}>{card.content.english}</Link>
                  </h2>
                  <p className="russian-side" lang="ru">
                    {card.content.russian}
                  </p>
                  {card.content.context && (
                    <p className="card-context">{card.content.context}</p>
                  )}
                  <div className="vocabulary-meta">
                    <span>
                      Version {card.version}
                      {card.status === "archived" ? " / Archived" : ""}
                    </span>
                    <Link
                      to={"/list/" + card.id}
                      aria-label={"Manage " + card.content.english}
                    >
                      Open card
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="list-empty">
              <span className="eyebrow">ROOM FOR SOMETHING USEFUL</span>
              <h2>
                {query
                  ? "No matching meanings."
                  : status === "archived"
                    ? "Nothing archived."
                    : "Your first keeper awaits."}
              </h2>
              <p>
                {query
                  ? "Try either language, a meaning, or a little context."
                  : status === "archived"
                    ? "Archived cards stay here until you restore or delete them."
                    : "Translate a word or phrase, then choose Add to my list. Nothing is saved automatically."}
              </p>
              <Link className="primary-button" to="/">
                Translate something
              </Link>
            </div>
          )}
          {data.total > data.pageSize && (
            <div className="pagination">
              <button
                type="button"
                className="secondary-button"
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous page
              </button>
              <span>
                Page {page} of {Math.ceil(data.total / data.pageSize)}
              </span>
              <button
                type="button"
                className="secondary-button"
                disabled={page * data.pageSize >= data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next page
              </button>
            </div>
          )}
        </section>
      )}
      <p className="fine-print library-note">
        Keep the meaning and context clear in both languages. Daily reviews
        arrive in the next phase.
      </p>
    </main>
  );
}
