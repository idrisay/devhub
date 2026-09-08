import * as vscode from 'vscode';
import { config } from '../infra/Config';
import type { Hub, HubSnapshot } from '../providers/Hub';

/**
 * One line that answers "what am I working on and is it on fire". This is the
 * surface you glance at fifty times a day, so it stays terse.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(hub: Hub) {
    this.item = vscode.window.createStatusBarItem('devhub.status', vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'DevHub';
    this.item.command = 'devhub.showActions';
    this.subscription = hub.onDidChange((snapshot) => this.render(snapshot));
    this.render(hub.current);
  }

  private render(snapshot: HubSnapshot): void {
    if (!config.statusBarEnabled()) {
      this.item.hide();
      return;
    }

    const { context, issue, errors, designs, loading } = snapshot;

    if (!context.ticketKey) {
      this.item.text = '$(git-branch) No ticket';
      this.item.tooltip = new vscode.MarkdownString(
        context.branch
          ? `No ticket key found in \`${context.branch}\`.\n\n[Pin a ticket](command:devhub.pinTicket)`
          : 'No Git repository detected.'
      );
      this.item.tooltip.isTrusted = true;
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }

    const parts = [`$(git-branch) ${context.ticketKey}`];
    if (issue) {
      parts.push(issue.status);
    }
    if (loading) {
      parts.push('$(sync~spin)');
    }

    const diffErrors = errors.filter((e) => e.matchesDiff).length;
    if (diffErrors > 0) {
      parts.push(`$(warning) ${diffErrors}`);
    }
    if (designs.length > 0) {
      parts.push(`$(symbol-color) ${designs.length}`);
    }

    this.item.text = parts.join(' · ');

    const tooltip = new vscode.MarkdownString('', true);
    tooltip.isTrusted = true;
    tooltip.appendMarkdown(`**${context.ticketKey}** ${issue ? `— ${issue.summary}` : ''}\n\n`);
    if (issue) {
      tooltip.appendMarkdown(`Status: ${issue.status}`);
      if (issue.assignee) {
        tooltip.appendMarkdown(` · ${issue.assignee}`);
      }
      tooltip.appendMarkdown('\n\n');
    }
    if (diffErrors > 0) {
      tooltip.appendMarkdown(`$(warning) ${diffErrors} production error(s) in files you changed\n\n`);
    }
    if (context.pinned) {
      tooltip.appendMarkdown('_Pinned_ · [Unpin](command:devhub.unpinTicket)\n\n');
    }
    tooltip.appendMarkdown('[Actions](command:devhub.showActions)');
    this.item.tooltip = tooltip;

    this.item.backgroundColor =
      diffErrors > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

    this.item.show();
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
