"use client";
export default function ErrorPage({ retry }: { retry: () => void }) {
  return (
    <main className="coming-soon">
      <span className="eyebrow">TEMPORARILY UNAVAILABLE</span>
      <h1>
        Let's try
        <br />
        that again.
      </h1>
      <p>
        Webcards could not reach its services. Check the local configuration and
        PostgreSQL connection.
      </p>
      <button className="primary-button" onClick={retry}>
        Try again
      </button>
    </main>
  );
}
