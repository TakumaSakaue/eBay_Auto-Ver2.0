import pLimit from "p-limit";
import pRetry, { AbortError } from "p-retry";
import { env } from "@/lib/env";

export function createLimiter(concurrency = env.CONCURRENCY) {
  return pLimit(concurrency);
}

export type Retryable<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => Promise<TResult>;

export function withRetry<TArgs extends unknown[], TResult>(
  fn: Retryable<TArgs, TResult>,
  options?: { retries?: number }
) {
  const retries = options?.retries ?? 5;
  return async (...args: TArgs): Promise<TResult> => {
    return pRetry(() => fn(...args), {
      retries,
      factor: 2,
      minTimeout: 1000,
      maxTimeout: 30000,
      onFailedAttempt(error) {
        const failed = error as { attemptNumber?: number; retriesLeft?: number; name: string; message: string };
        const att = failed.attemptNumber ?? 0;
        const rem = failed.retriesLeft ?? 0;
        console.warn(
          JSON.stringify({
            level: "warn",
            msg: "retrying",
            attempt: att,
            retriesLeft: rem,
            name: error.name,
            message: error.message,
          })
        );
      },
    });
  };
}

export function abortRetry(message: string) {
  throw new AbortError(message);
}


