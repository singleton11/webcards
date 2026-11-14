import { createHash } from "node:crypto";
import {
  TranslationError,
  type TranslationInput,
  type TranslationResult,
} from "./contracts";
export class TranslationService {
  private pending = new Map<
    string,
    { hash: string; expires: number; promise: Promise<TranslationResult> }
  >();
  private active = 0;
  constructor(
    private dependencies: {
      reserve: (owner: string) => Promise<boolean>;
      run: (input: TranslationInput) => Promise<TranslationResult>;
    },
  ) {}
  async submit(owner: string, input: TranslationInput) {
    const now = Date.now();
    for (const [key, value] of this.pending)
      if (value.expires < now) this.pending.delete(key);
    const key = owner + ":" + input.requestId;
    const hash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const existing = this.pending.get(key);
    if (existing) {
      if (hash !== existing.hash)
        throw new TranslationError(
          "request_conflict",
          409,
          "This request ID was already used with different text.",
        );
      return existing.promise;
    }
    if (this.active >= 2)
      throw new TranslationError(
        "busy",
        429,
        "Two translations are already running. Please wait a moment.",
      );
    this.active++;
    const promise = (async () => {
      try {
        if (!(await this.dependencies.reserve(owner)))
          throw new TranslationError(
            "daily_limit",
            429,
            "Today's translation limit has been reached. Your text has not been sent.",
          );
        return await this.dependencies.run(input);
      } finally {
        this.active--;
      }
    })();
    // A bounded, process-local replay window, not a permanent translation history.
    this.pending.set(key, { hash, expires: now + 60_000, promise });
    promise.catch(() => {
      this.pending.delete(key);
    });
    return promise;
  }
}
