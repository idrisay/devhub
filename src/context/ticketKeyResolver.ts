import { config } from '../infra/Config';

/**
 * Finds a ticket key such as PROJ-1234 in arbitrary text.
 *
 * Deliberately conservative: it anchors on a word boundary so that a hash like
 * `A1-2` inside a filename doesn't match, and it rejects keys preceded by a
 * hyphen so `v2-PROJ-1` still yields `PROJ-1` rather than `2-PROJ`.
 */
export function findTicketKey(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  let pattern: RegExp;
  try {
    pattern = new RegExp(`(?<![A-Za-z0-9-])(${config.ticketKeyPattern()})(?![A-Za-z0-9])`, 'g');
  } catch {
    // A malformed user pattern must not take the extension down.
    pattern = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]+-\d+)(?![A-Za-z0-9])/g;
  }

  const match = pattern.exec(text.toUpperCase());
  return match?.[1];
}

/** Turns an issue summary into a branch-safe slug. */
export function slugify(summary: string, maxLength = 48): string {
  const slug = summary
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) {
    return slug;
  }
  return slug.slice(0, maxLength).replace(/-[^-]*$/, '');
}

export function renderBranchName(template: string, key: string, summary: string, type: string): string {
  return template
    .replace(/\$\{key\}/g, key)
    .replace(/\$\{slug\}/g, slugify(summary))
    .replace(/\$\{type\}/g, slugify(type || 'task', 12))
    .replace(/\/{2,}/g, '/');
}
