import type { WorkContext } from '../context/WorkContextService';
import type { ProviderId } from '../infra/AuthManager';
import { repoWorkFingerprint } from '../context/repoWork';
import { repoSlug } from './github/remoteUrl';

/**
 * The parts of the work context that a provider request is actually keyed on.
 *
 * `changedFiles` is deliberately absent. It changes on every save — the Git
 * extension fires a state event for each one — and no request is keyed on it:
 * Sentry uses it to filter a list it has already fetched, and nothing else
 * reads it. Including it meant every save cancelled the fan-out that was still
 * running and started another, so a request could be aborted and re-issued
 * indefinitely while the sidebar sat on "Loading…" the whole time.
 */
export function contextFingerprint(ctx: WorkContext): string {
  return [
    ctx.ticketKey ?? '',
    ctx.branch ?? '',
    ctx.repoRoot ?? '',
    ctx.pinned ? 'pinned' : '',
    ctx.repos.map(repoSlug).join(','),
    repoWorkFingerprint(ctx.work)
  ].join('|');
}

/** Everything on top of the fingerprint that a view renders. */
export function viewFingerprint(ctx: WorkContext): string {
  return `${contextFingerprint(ctx)}|${ctx.changedFiles.join('|')}`;
}

export type ProviderFlags = Readonly<Record<ProviderId, boolean>>;

export const NO_PROVIDERS: ProviderFlags = {
  jira: false,
  figma: false,
  sentry: false,
  github: false,
  grafana: false
};

export function providerFlags(ids: ReadonlySet<ProviderId>): ProviderFlags {
  return { ...NO_PROVIDERS, ...Object.fromEntries([...ids].map((id) => [id, true])) };
}

export type RefreshDecision =
  /** Fan out to the providers now. */
  | { run: 'now' }
  /** An identical fan-out is already running; wait for its result. */
  | { run: 'join' }
  /** Too soon after the last one; run it when the window closes. */
  | { run: 'later'; inMs: number };

export interface RefreshWindow {
  /** A user-initiated refresh, which always runs. */
  force: boolean;
  fingerprint: string;
  /** Fingerprint of the fan-out currently running, if there is one. */
  inFlight?: string;
  /** Fingerprint of the last fan-out that completed. */
  lastFingerprint?: string;
  lastCompletedAt?: number;
  now: number;
  minIntervalMs: number;
}

/**
 * Whether a trigger earns a round of provider requests.
 *
 * Focus changes, branch checkouts, saves and Git index writes all land here,
 * and most of them ask for exactly what the last one asked for. Three rules:
 * a user-initiated refresh always runs; a trigger that repeats the context of a
 * fan-out already in flight joins it rather than cancelling it; and a repeat of
 * the last completed context waits out a minimum interval. A context that
 * genuinely moved — a different branch, repo or ticket — always runs at once,
 * because that is the case the caches cannot answer.
 */
export function planRefresh(w: RefreshWindow): RefreshDecision {
  if (w.force) {
    return { run: 'now' };
  }
  if (w.inFlight !== undefined) {
    // Cancelling is only right when the context moved on: otherwise the running
    // fan-out is already fetching this exact answer.
    return w.inFlight === w.fingerprint ? { run: 'join' } : { run: 'now' };
  }
  if (w.lastFingerprint !== w.fingerprint) {
    return { run: 'now' };
  }
  const since = w.now - (w.lastCompletedAt ?? 0);
  return since >= w.minIntervalMs ? { run: 'now' } : { run: 'later', inMs: w.minIntervalMs - since };
}

export type SectionState =
  /** There is data to show. Never replace it with a spinner. */
  | 'ready'
  /** Nothing to show yet, because the provider has not answered once. */
  | 'first-load'
  /** The provider has answered and there is genuinely nothing. */
  | 'empty';

/**
 * What a view should render for one section.
 *
 * The rule the sidebar kept breaking: a spinner is only ever right when there
 * is nothing else to put there. Once a section has rows, a background refresh
 * must leave them alone — the rows are at most one interval stale, which is
 * infinitely more useful than "Loading…" — and an empty section may only claim
 * to be empty once its provider has actually answered for the context on
 * screen. `answered` is how a view establishes that second half.
 */
export function sectionState(section: { hasData: boolean; answered: boolean }): SectionState {
  if (section.hasData) {
    return 'ready';
  }
  // Not having heard yet is not the same as there being nothing to hear. Every
  // provider call resolves — failures come back as a status the views render
  // rather than as a throw — so a section that is still waiting says so instead
  // of announcing an all-clear it has no evidence for.
  return section.answered ? 'empty' : 'first-load';
}

/**
 * Whether a provider's answer for the work context currently on screen is in
 * hand.
 *
 * Both halves matter. `loaded` alone would have a branch switch claim there is
 * no pull request for the new branch before anyone has looked. `contextLoaded`
 * alone would say the same thing when GitHub is simply not connected. And
 * neither is a refresh flag, which is the point: a background round leaves both
 * of these true, so it cannot put a spinner over rows that are already there.
 */
export function answered(
  snapshot: { loaded: ProviderFlags; contextLoaded: boolean },
  id: ProviderId
): boolean {
  return snapshot.loaded[id] && snapshot.contextLoaded;
}
