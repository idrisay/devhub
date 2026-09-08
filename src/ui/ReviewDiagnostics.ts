import * as path from 'path';
import * as vscode from 'vscode';
import type { Hub, HubSnapshot } from '../providers/Hub';

/**
 * Review comments on the current branch's pull request, on the lines they were
 * left on.
 *
 * Information severity, not warning: these are someone's remarks, not defects,
 * and the Problems panel is shared with Sentry's production errors — which are
 * warnings — so the two stay tellable apart at a glance.
 */
export class ReviewDiagnostics implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly subscription: vscode.Disposable;

  constructor(hub: Hub) {
    this.collection = vscode.languages.createDiagnosticCollection('devhub-review');
    this.subscription = hub.onDidChange((snapshot) => this.render(snapshot));
    this.render(hub.current);
  }

  private render(snapshot: HubSnapshot): void {
    this.collection.clear();

    const pull = snapshot.pull;
    const root = snapshot.context.repoRoot;
    // Comments on merged or closed work are history, not something to act on.
    if (!pull || !root || pull.state === 'merged' || pull.state === 'closed') {
      return;
    }

    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const comment of pull.comments) {
      // A comment on the pull request as a whole has neither, and belongs to no line.
      if (!comment.line || !comment.path) {
        continue;
      }
      const file = path.join(root, comment.path);
      const line = Math.max(comment.line - 1, 0);

      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        `${comment.author}: ${comment.body.replace(/\s+/g, ' ').slice(0, 300)}`,
        vscode.DiagnosticSeverity.Information
      );
      diagnostic.source = `PR #${pull.number}`;
      diagnostic.code = { value: 'review', target: vscode.Uri.parse(comment.url) };

      byFile.set(file, [...(byFile.get(file) ?? []), diagnostic]);
    }

    for (const [file, diagnostics] of byFile) {
      this.collection.set(vscode.Uri.file(file), diagnostics);
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.collection.dispose();
  }
}
