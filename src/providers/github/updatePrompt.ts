import { describePull, type PullState, type PullSummary } from './pullStatus';

/**
 * The text the "my open pull requests" copy button puts on the clipboard.
 *
 * The counterpart to the review prompt: that one asks for a review of someone
 * else's work, this one asks for your own to be unblocked. It is deliberately
 * told to go and read the pull request rather than being handed the review
 * comments inline — the queue query fetches only how many threads are
 * unresolved, not what they say, and keeping it that way is what lets both
 * queues stay a single GraphQL request.
 *
 * Escaped as `\${...}` so the placeholders survive into the string rather than
 * being interpolated here.
 */
export const DEFAULT_UPDATE_PROMPT_TEMPLATE = `Update \${url} using gh. It is currently blocked on: \${state}. Read the review threads with \`gh pr view \${number} --repo \${repo} --comments\`, the changes with \`gh pr diff \${number} --repo \${repo}\`, and the failing jobs with \`gh pr checks \${number} --repo \${repo}\`. If possible, retrieve and include the related ticket content as additional context. Then check out the branch and address every unresolved review comment, rebase onto the base branch if it conflicts, and fix whatever the checks are failing on — run the tests locally before pushing. Push the result and reply to each review thread saying what you changed, as my reply. Do not mention any AI or model names in the replies.`;

export const UPDATE_PROMPT_PLACEHOLDERS = [
  'url',
  'repo',
  'number',
  'title',
  'state',
  'key'
] as const;

/** What `\${state}` is when nothing is flagged, so the prompt still reads. */
const NOTHING_BLOCKING = 'nothing — check whether it is ready to merge';

/**
 * Fills a template in from one of your own pull requests.
 *
 * `\${state}` is the row's own words for what is wrong — "Conflicts · Changes
 * requested · Checks failing" — so the pasted text says up front what it is
 * being asked to fix, and matches what you were looking at when you clicked.
 *
 * `ticketKey` is resolved by the caller, which owns the configured key pattern.
 * As in the review prompt, a recognised-but-absent placeholder renders empty
 * while a genuine typo is left as written, so it can be seen and fixed.
 */
export function renderUpdatePrompt(
  template: string,
  pull: Pick<PullSummary, 'url' | 'repo' | 'number' | 'title'> & PullState,
  ticketKey = ''
): string {
  const flagged = describePull(pull);
  const values: Record<string, string> = {
    url: pull.url,
    repo: pull.repo,
    number: String(pull.number),
    title: pull.title,
    state: flagged === 'Open' ? NOTHING_BLOCKING : flagged,
    key: ticketKey
  };
  return template.replace(/\$\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
