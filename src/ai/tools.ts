import * as vscode from 'vscode';
import type { Hub } from '../providers/Hub';
import { extractFigmaRefs } from '../providers/figma/urlParser';

/**
 * These tools are the real product of the AI layer. They work inside agent mode
 * and any other surface that consumes language model tools, whereas a chat
 * participant only fires when someone explicitly invokes it.
 */

function text(value: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);
}

export function registerTools(hub: Hub): vscode.Disposable[] {
  const getTicket = vscode.lm.registerTool<{ key?: string }>('devhub_getTicket', {
    async prepareInvocation(options) {
      const key = options.input.key ?? hub.current.context.ticketKey;
      return { invocationMessage: key ? `Reading ${key}` : 'Reading the current ticket' };
    },
    async invoke(options, token) {
      const key = options.input.key ?? hub.current.context.ticketKey;
      if (!key) {
        return text('No ticket is associated with the current branch. Ask the user which issue to use.');
      }
      const issue = await hub.jira.getIssue(key, token);
      if (!issue) {
        return text(`Could not load ${key}. Jira may not be connected — check the DevHub Connections view.`);
      }

      const lines = [
        `# ${issue.key}: ${issue.summary}`,
        '',
        `Status: ${issue.status} · Type: ${issue.issueType}` +
          (issue.priority ? ` · Priority: ${issue.priority}` : '') +
          (issue.assignee ? ` · Assignee: ${issue.assignee}` : ''),
        `URL: ${issue.url}`,
        '',
        '## Description',
        issue.description || '_No description._'
      ];

      if (issue.subtasks.length) {
        lines.push('', '## Subtasks');
        issue.subtasks.forEach((s) => lines.push(`- ${s.key} (${s.status}): ${s.summary}`));
      }

      if (issue.comments.length) {
        lines.push('', '## Recent comments');
        issue.comments.slice(-5).forEach((c) => lines.push(`**${c.author}**: ${c.body}`, ''));
      }

      return text(lines.join('\n'));
    }
  });

  const getErrors = vscode.lm.registerTool<{ query?: string }>('devhub_getErrors', {
    async prepareInvocation() {
      return { invocationMessage: 'Checking production errors' };
    },
    async invoke(options, token) {
      const ctx = hub.current.context;
      const issues = options.input.query
        ? await hub.sentry.forContext(ctx, token)
        : hub.current.errors.length > 0
          ? hub.current.errors
          : await hub.sentry.forContext(ctx, token);

      if (issues.length === 0) {
        return text('No unresolved Sentry issues match the current branch or the files you changed.');
      }

      const lines = [`Found ${issues.length} unresolved production issue(s).`, ''];
      for (const issue of issues.slice(0, 10)) {
        lines.push(
          `## ${issue.title}`,
          `${issue.count} events · ${issue.userCount} users affected · level ${issue.level}`,
          `Culprit: ${issue.culprit}`,
          issue.matchesDiff ? 'Touches a file changed on this branch.' : '',
          `URL: ${issue.permalink}`
        );
        const frames = (issue.frames ?? []).slice(0, 5);
        if (frames.length) {
          lines.push('', 'Top stack frames (innermost first):');
          frames.forEach((f) =>
            lines.push(`- ${f.function ?? 'anonymous'} at ${f.filename ?? 'unknown'}:${f.lineNo ?? '?'}`)
          );
        }
        lines.push('');
      }
      return text(lines.filter((l) => l !== undefined).join('\n'));
    }
  });

  const getDesign = vscode.lm.registerTool<{ url?: string }>('devhub_getDesign', {
    async prepareInvocation() {
      return { invocationMessage: 'Reading design context' };
    },
    async invoke(options, token) {
      const frames = options.input.url
        ? await hub.figma.load(extractFigmaRefs(options.input.url), token)
        : hub.current.designs.length > 0
          ? hub.current.designs
          : await hub.figma.forContext(hub.current.context, token);

      if (frames.length === 0) {
        return text(
          'No Figma frames are linked from the current ticket. Paste a frame URL into the ticket, or pass one to this tool.'
        );
      }

      const lines: string[] = [];
      for (const frame of frames) {
        lines.push(
          `## ${frame.name} (${frame.type})`,
          frame.width && frame.height
            ? `Size: ${Math.round(frame.width)} × ${Math.round(frame.height)}`
            : '',
          frame.colors.length ? `Colours: ${frame.colors.join(', ')}` : '',
          frame.typography.length ? `Type: ${frame.typography.join(' · ')}` : '',
          `URL: ${frame.url}`,
          ''
        );
      }
      lines.push(
        'Use these exact colour and type values rather than approximating them. If the project has a design token file, map to those tokens instead of hardcoding hex values.'
      );
      return text(lines.filter(Boolean).join('\n'));
    }
  });

  return [getTicket, getErrors, getDesign];
}
