import type * as vscode from 'vscode';
import type { ProviderId } from '../infra/AuthManager';
import type { WorkContext } from '../context/WorkContextService';

export type ProviderHealth = 'ok' | 'unconfigured' | 'auth-expired' | 'rate-limited' | 'error';

export interface ProviderStatus {
  health: ProviderHealth;
  detail?: string;
  /** Longer explanation for tooltips, when `detail` is only a label. */
  hint?: string;
}

/**
 * Every integration implements this. The UI layer only ever talks to this shape,
 * which is why a fifth service is a day's work rather than a refactor.
 */
export interface Provider<TItem> {
  readonly id: ProviderId;
  readonly displayName: string;

  isConfigured(): boolean;

  /** Items relevant to the current work context. */
  forContext(ctx: WorkContext, token: vscode.CancellationToken): Promise<TItem[]>;

  status(): ProviderStatus;

  /**
   * The stored token for this provider was replaced or deleted, so any status
   * cached from a previous credential is void. Required rather than optional:
   * a provider that skips it keeps reporting `ok` after being disconnected,
   * which is the one lie the Connections view must never tell.
   */
  onCredentialsChanged(): void;

  dispose(): void;
}

/** Normalises the errors a provider can hit into a status the UI can render. */
export function statusFromError(err: unknown): ProviderStatus {
  const anyErr = err as { isAuth?: boolean; isRateLimit?: boolean; message?: string };
  if (anyErr?.isAuth) {
    return { health: 'auth-expired', detail: 'Credentials rejected. Reconnect to continue.' };
  }
  if (anyErr?.isRateLimit) {
    return { health: 'rate-limited', detail: 'Rate limited. Backing off.' };
  }
  return { health: 'error', detail: anyErr?.message ?? 'Unknown error' };
}
