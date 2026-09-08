import type { PullSummary } from './pullStatus';

/**
 * The text the review queue's copy button puts on the clipboard.
 *
 * Same arrangement as the tasks prompt: the real default lives here, and
 * `devhub.github.reviewPromptTemplate` defaults to empty meaning "use this",
 * so there is only ever one copy of it. Escaped as `\${...}` so the
 * placeholders survive into the string rather than being interpolated here.
 */
export const DEFAULT_REVIEW_PROMPT_TEMPLATE = `Review \${url} using gh. Also use OpenCode, Codex, and OpenRouter to independently review the changes. If possible, retrieve and include the related ticket content as additional context. Combine their findings with your own review into a single, concise review and submit it to GitHub as my review. Do not mention OpenCode, OpenRouter, Codex, or any AI/model names, such as MiniMax M3 Free or Opus, in the GitHub review.`;

export const REVIEW_PROMPT_PLACEHOLDERS = [
  'url',
  'repo',
  'number',
  'title',
  'author',
  'key'
] as const;

/**
 * Fills a template in from one pull request.
 *
 * `ticketKey` is resolved by the caller, which owns the configured key pattern.
 * It is a recognised placeholder even when nothing was found, so `\${key}`
 * renders empty rather than being left in the pasted text — unlike a genuine
 * typo, which is left as written so it can be seen and fixed.
 */
export function renderReviewPrompt(
  template: string,
  pull: Pick<PullSummary, 'url' | 'repo' | 'number' | 'title' | 'author'>,
  ticketKey = ''
): string {
  const values: Record<string, string> = {
    url: pull.url,
    repo: pull.repo,
    number: String(pull.number),
    title: pull.title,
    author: pull.author,
    key: ticketKey
  };
  return template.replace(/\$\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
