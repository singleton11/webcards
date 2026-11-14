export class CardRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function cardRequest<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: signal ?? AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok)
      throw new CardRequestError(
        result.error || "Vocabulary is unavailable.",
        response.status,
      );
    return result as T;
  } catch (error) {
    if (error instanceof CardRequestError) throw error;
    throw new CardRequestError(
      body === undefined
        ? "Connection interrupted. Could not load your vocabulary; please retry."
        : "Connection interrupted. We could not confirm the change; retry the same action safely.",
      0,
    );
  }
}
