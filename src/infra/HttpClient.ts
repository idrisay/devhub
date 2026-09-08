import type * as vscode from 'vscode';
import { log } from './Logger';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
    /** Jira sets `x-authentication-denied-reason` to flag a CAPTCHA challenge. */
    readonly deniedReason?: string
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isRateLimit(): boolean {
    return this.status === 429;
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Request cancelled');
    this.name = 'CancelledError';
  }
}

export class TimeoutError extends Error {
  constructor(
    readonly url: string,
    readonly ms: number
  ) {
    super(`Request to ${url} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * A 200 that isn't JSON. Nearly always an SSO or login page served in place of
 * the API, which is worth saying out loud rather than surfacing a parse error.
 */
export class NonJsonResponseError extends Error {
  constructor(
    readonly url: string,
    readonly contentType: string,
    readonly snippet: string
  ) {
    super(`Expected JSON from ${url} but got ${contentType || 'an unknown content type'}`);
    this.name = 'NonJsonResponseError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: unknown;
  token?: vscode.CancellationToken;
  /** Skip single-flight dedupe. Required for anything with side effects. */
  mutating?: boolean;
  /** Overrides DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

function sleep(ms: number, token?: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    token?.onCancellationRequested(() => {
      clearTimeout(timer);
      reject(new CancelledError());
    });
  });
}

/** Exponential backoff with jitter, capped, honouring Retry-After when present. */
function backoffDelay(attempt: number, retryAfterHeader: string | null): number {
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 30_000);
  }
  const base = Math.min(2 ** attempt * 500, 8000);
  return base + Math.random() * 250;
}

export class HttpClient {
  /** Concurrent identical GETs collapse into one network call. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  async json<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const key = `${method} ${url}`;

    if (method === 'GET' && !options.mutating) {
      const existing = this.inFlight.get(key) as Promise<T> | undefined;
      if (existing) {
        return existing;
      }
      const promise = this.execute<T>(url, options).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, promise);
      return promise;
    }

    return this.execute<T>(url, options);
  }

  async buffer(url: string, options: RequestOptions = {}): Promise<Uint8Array> {
    const response = await this.send(url, options);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async execute<T>(url: string, options: RequestOptions): Promise<T> {
    const response = await this.send(url, options);
    if (response.status === 204) {
      return undefined as T;
    }
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    if (!text) {
      return undefined as T;
    }
    if (!/\bjson\b/i.test(contentType)) {
      throw new NonJsonResponseError(url, contentType, text.slice(0, 200));
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new NonJsonResponseError(url, contentType, text.slice(0, 200));
    }
  }

  private async send(url: string, options: RequestOptions): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (options.token?.isCancellationRequested) {
        throw new CancelledError();
      }

      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const controller = new AbortController();
      const subscription = options.token?.onCancellationRequested(() => controller.abort());
      // A request that never settles is the worst failure to debug, so cap it.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        const response = await fetch(url, {
          method: options.method ?? 'GET',
          headers: {
            Accept: 'application/json',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal
        });

        if (response.ok) {
          return response;
        }

        const retryable = response.status === 429 || response.status >= 500;
        const body = await response.text().catch(() => '');

        if (!retryable || attempt === MAX_ATTEMPTS - 1) {
          throw new HttpError(
            response.status,
            url,
            body.slice(0, 500),
            response.headers.get('x-authentication-denied-reason') ?? undefined
          );
        }

        const delay = backoffDelay(attempt, response.headers.get('retry-after'));
        log.warn(`${response.status} from ${url}, retrying in ${Math.round(delay)}ms`);
        await sleep(delay, options.token);
      } catch (err) {
        if (err instanceof HttpError || err instanceof CancelledError) {
          throw err;
        }
        // Retrying a timeout only multiplies the wait the user already sat through.
        if (timedOut) {
          throw new TimeoutError(url, timeoutMs);
        }
        if (controller.signal.aborted) {
          throw new CancelledError();
        }
        lastError = err;
        if (attempt === MAX_ATTEMPTS - 1) {
          break;
        }
        await sleep(backoffDelay(attempt, null), options.token);
      } finally {
        clearTimeout(timer);
        subscription?.dispose();
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`Request to ${url} failed`);
  }
}

export const http = new HttpClient();
