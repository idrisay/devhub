import * as vscode from 'vscode';
import { config } from '../infra/Config';
import type { Hub, HubSnapshot } from '../providers/Hub';
import type { LocatedIssue } from '../providers/sentry/SentryProvider';

/**
 * Production errors as squiggles on the line that actually threw. This is the
 * highest-value part of the Sentry integration and it lives or dies on the path
 * mapping being right — an unresolvable frame is dropped rather than guessed.
 */
export class SentryDiagnostics implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly lensProvider: SentryCodeLensProvider;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(hub: Hub) {
    this.collection = vscode.languages.createDiagnosticCollection('devhub-sentry');
    this.lensProvider = new SentryCodeLensProvider();

    this.disposables.push(
      this.collection,
      this.lensProvider,
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this.lensProvider),
      hub.onDidChange((snapshot) => this.render(snapshot)),
      config.onDidChange(() => this.render(hub.current))
    );

    this.render(hub.current);
  }

  private render(snapshot: HubSnapshot): void {
    this.collection.clear();

    if (!config.sentry.diagnostics()) {
      this.lensProvider.update([]);
      return;
    }

    const byFile = new Map<string, vscode.Diagnostic[]>();

    for (const issue of snapshot.errors) {
      // Only the throw site gets a squiggle. Marking every frame in the trace
      // turns the Problems panel into noise.
      const location = issue.locations[0];
      if (!location) {
        continue;
      }

      const range = new vscode.Range(
        Math.max(location.line - 1, 0),
        0,
        Math.max(location.line - 1, 0),
        Number.MAX_SAFE_INTEGER
      );

      const diagnostic = new vscode.Diagnostic(
        range,
        `${issue.title} — ${issue.count} events, ${issue.userCount} users affected`,
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = 'Sentry';
      diagnostic.code = { value: issue.shortId, target: vscode.Uri.parse(issue.permalink) };

      const existing = byFile.get(location.file) ?? [];
      existing.push(diagnostic);
      byFile.set(location.file, existing);
    }

    for (const [file, diagnostics] of byFile) {
      this.collection.set(vscode.Uri.file(file), diagnostics);
    }

    this.lensProvider.update(config.sentry.codeLens() ? snapshot.errors : []);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

class SentryCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private issues: LocatedIssue[] = [];

  update(issues: LocatedIssue[]): void {
    this.issues = issues;
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const seen = new Set<number>();

    for (const issue of this.issues) {
      for (const location of issue.locations) {
        if (location.file !== document.uri.fsPath) {
          continue;
        }
        const line = Math.max(location.line - 1, 0);
        if (seen.has(line) || line >= document.lineCount) {
          continue;
        }
        seen.add(line);
        lenses.push(
          new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
            title: `$(warning) ${issue.count} events in production — open in Sentry`,
            command: 'vscode.open',
            arguments: [vscode.Uri.parse(issue.permalink)]
          })
        );
      }
    }

    return lenses;
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
  }
}
