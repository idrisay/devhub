/**
 * Row text that leaves the description room to be read.
 *
 * VS Code lays a tree row out as label then description, and the label gets the
 * space: a long enough label pushes the description off the end of the row.
 * That is where the age, the repository and the review state live — the columns
 * you were scanning for in the first place. Nothing in the API reports how wide
 * the sidebar is, and a row cannot wrap, so the only lever is to stop the title
 * taking all of it.
 *
 * Nothing is lost by clamping: every row's tooltip carries the full text.
 */

/** Characters of label a row can afford before the description starts losing. */
export const DEFAULT_TITLE_LENGTH = 40;

/**
 * A title never clamps below this, even when the leading parts are long. Three
 * words of a summary are worth more than a column of ellipses.
 */
const MIN_TITLE = 14;

/** Below this the ellipsis costs more than it saves. */
const MIN_BUDGET = 8;

/**
 * Clamps `title` to `budget` characters, breaking on a word where one falls
 * near the end. A long first word is cut mid-word rather than left as a stub.
 */
export function clampTitle(title: string, budget = DEFAULT_TITLE_LENGTH): string {
  const text = title.trim().replace(/\s+/g, ' ');
  if (budget <= 0 || text.length <= budget) {
    return text;
  }
  const limit = Math.max(budget, MIN_BUDGET);
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  const kept = space > limit * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.trimEnd()}…`;
}

export interface RowLabel {
  /** Parts that must stay readable whatever happens — a key, a number. */
  lead?: string;
  title: string;
  /** What separates the lead from the title. Two spaces reads as a gutter. */
  separator?: string;
  /** Total characters for the row, or 0 to leave the title alone. */
  budget?: number;
}

/**
 * A label whose leading parts are always intact and whose title is clamped to
 * whatever budget they leave.
 */
export function rowLabel({
  lead,
  title,
  separator = ' · ',
  budget = DEFAULT_TITLE_LENGTH
}: RowLabel): string {
  if (!lead) {
    return clampTitle(title, budget);
  }
  const remaining = budget <= 0 ? 0 : Math.max(budget - lead.length - separator.length, MIN_TITLE);
  return `${lead}${separator}${clampTitle(title, remaining)}`;
}

/**
 * The description, in the order it should survive being clipped: put what you
 * would scan for first. Empty parts drop out, and an empty result is
 * `undefined`, which is what VS Code wants for "no description".
 */
export function rowMeta(...parts: (string | undefined | false)[]): string | undefined {
  const kept = parts.filter((part): part is string => Boolean(part && part.trim()));
  return kept.length > 0 ? kept.join(' · ') : undefined;
}
