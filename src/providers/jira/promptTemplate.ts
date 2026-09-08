import type { JiraIssue } from './JiraClient';

/**
 * The text the tasks view's copy button puts on the clipboard.
 *
 * Kept here rather than in package.json so there is one copy of it: the
 * `devhub.tasks.promptTemplate` setting defaults to empty and means "use this".
 * Escaped as `\${...}` so the placeholders survive into the string instead of
 * being interpolated at build time.
 */
export const DEFAULT_PROMPT_TEMPLATE = `Implement the Jira ticket \${url}, in two stages: investigate and report a confidence score first, then implement only after I give you the green flag. Stage 1 - do not change a single line of code yet. Retrieve the ticket content with the Atlassian MCP connector and read its description and acceptance criteria. If the ticket links a Figma design, read it with the Figma MCP get_design_context tool — that call is the only one that returns the real styles and classes — and fetch its screenshots too. Then investigate the codebase and report a confidence score out of 100 for implementing this ticket, with a short note on what is clear, what is ambiguous and what you would assume, the files you would touch, and the questions that would raise the score. Stop there and wait for my explicit green flag; if I answer your questions, give me the updated score and wait again. Stage 2 - only once I have said go: implement it, checking the implementation against the classes and styles get_design_context reported rather than eyeballing the design. Once the implementation is complete, use OpenCode, Codex, and OpenRouter to independently check the implemented code, then fold anything they find worth fixing into your own changes. Then commit on a feature branch created from develop and push it to GitHub. Before opening the pull request, ask me which reviewers to request as a multi-select question listing the team's GitHub handles, and wait for my answer; then open the pull request targeting develop and request a review on GitHub from exactly the people I picked. Do not mention OpenCode, OpenRouter, Codex, or any AI/model names, such as MiniMax M3 Free or Opus, in commit messages, pull request descriptions, or ticket comments.`;

/** The placeholders a template may use, and where each one comes from. */
export const PROMPT_PLACEHOLDERS = ['url', 'key', 'summary', 'type', 'status'] as const;

/**
 * Fills a template in from one issue.
 *
 * An unrecognised placeholder is left as written rather than replaced with an
 * empty string: a typo shows up in the pasted text, where it can be seen and
 * fixed, instead of silently deleting a line of the instructions.
 */
export function renderPrompt(
  template: string,
  issue: Pick<JiraIssue, 'key' | 'summary' | 'issueType' | 'status' | 'url'>
): string {
  const values: Record<string, string> = {
    url: issue.url,
    key: issue.key,
    summary: issue.summary,
    type: issue.issueType,
    status: issue.status
  };
  return template.replace(/\$\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
