/** Region hosts and the like — never an organization. */
const NOT_A_SLUG = new Set(['www', 'sentry', 'us', 'de', 'eu']);

/**
 * Takes the organization slug out of whatever the user pasted.
 *
 * Sentry only ever shows people a URL — `https://acme.sentry.io/` in the
 * browser bar, `.../organizations/acme/projects/` on the settings pages — but
 * the API wants the bare slug. Pasting the URL is the obvious thing to do and
 * it silently 404s every request, so accept both forms here instead.
 */
export function normaliseOrgSlug(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }

  // `.../organizations/<slug>/...`, the form the dashboard and settings use.
  // Checked first: a regional host like us.sentry.io would otherwise look like
  // a subdomain slug.
  const inPath = trimmed.match(/\/organizations\/([^/?#]+)/i);
  if (inPath) {
    return inPath[1];
  }

  // `<slug>.sentry.io`, the organization's own subdomain.
  const inHost = trimmed.match(/^(?:https?:\/\/)?([^./?#]+)\.(?:[a-z0-9-]+\.)*sentry\.io\b/i);
  if (inHost && !NOT_A_SLUG.has(inHost[1].toLowerCase())) {
    return inHost[1];
  }

  // Already a bare slug, or something unparseable — pass it through so the API
  // gets to say what's wrong with it rather than guessing here.
  return trimmed.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
}
