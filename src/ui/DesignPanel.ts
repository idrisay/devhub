import * as vscode from 'vscode';
import type { CacheStore } from '../infra/CacheStore';
import { answered } from '../providers/refreshPlan';
import type { Hub, HubSnapshot } from '../providers/Hub';
import type { DesignFrame } from '../providers/figma/FigmaProvider';

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The one place a webview is justified: rendered frames need pixels. Everything
 * is styled with VS Code's own theme variables so it never glows white in a
 * dark theme, and images are served through asWebviewUri from the blob cache —
 * Figma's own S3 URLs expire within minutes.
 */
export class DesignPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'devhub.designs';

  private view?: vscode.WebviewView;
  private snapshot: HubSnapshot;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly hub: Hub,
    private readonly cache: CacheStore
  ) {
    this.snapshot = hub.current;
    this.disposables.push(
      hub.onDidChange((s) => {
        this.snapshot = s;
        this.render();
      })
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.cache.blobRoot]
    };
    view.webview.onDidReceiveMessage((message: { command: string; url?: string }) => {
      if (message.command === 'open' && message.url) {
        void vscode.env.openExternal(vscode.Uri.parse(message.url));
      }
      if (message.command === 'connect') {
        void vscode.commands.executeCommand('devhub.signIn');
      }
    });
    this.render();
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.html = this.html(this.view.webview);
    this.view.badge =
      this.snapshot.designs.length > 0
        ? { value: this.snapshot.designs.length, tooltip: `${this.snapshot.designs.length} frames` }
        : undefined;
  }

  private html(webview: vscode.Webview): string {
    const n = nonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src 'nonce-${n}'`,
      `script-src 'nonce-${n}'`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${n}">
  body {
    margin: 0;
    padding: 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
  }
  .empty {
    color: var(--vscode-descriptionForeground);
    padding: 8px 4px;
    line-height: 1.5;
  }
  .frame {
    margin-bottom: 14px;
  }
  .thumb {
    display: block;
    width: 100%;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    background: var(--vscode-editor-background);
    cursor: pointer;
  }
  .thumb:hover { border-color: var(--vscode-focusBorder); }
  .name {
    margin-top: 5px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
  .swatches { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .swatch {
    width: 14px; height: 14px; border-radius: 3px;
    border: 1px solid var(--vscode-panel-border);
  }
  button {
    font-family: inherit; font-size: inherit;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none; padding: 5px 12px; border-radius: 2px; cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
${this.body()}
<script nonce="${n}">
  const vscodeApi = acquireVsCodeApi();
  document.body.addEventListener('click', (event) => {
    const target = event.target.closest('[data-url]');
    if (target) { vscodeApi.postMessage({ command: 'open', url: target.dataset.url }); }
    if (event.target.id === 'connect') { vscodeApi.postMessage({ command: 'connect' }); }
  });
</script>
</body>
</html>`;
  }

  private body(): string {
    const status = this.hub.figma.status();

    if (status.health === 'unconfigured') {
      return `<div class="empty"><p>${escapeHtml(status.detail ?? 'Figma is not connected.')}</p>
        <button id="connect">Connect Figma</button></div>`;
    }
    if (status.health === 'auth-expired') {
      return `<div class="empty"><p>Figma rejected the stored token.</p>
        <button id="connect">Reconnect Figma</button></div>`;
    }
    if (!this.snapshot.context.ticketKey) {
      return '<div class="empty">Designs appear once a ticket is detected for this branch.</div>';
    }
    if (this.snapshot.designs.length === 0) {
      return answered(this.snapshot, 'figma')
        ? `<div class="empty">No Figma links found on ${escapeHtml(
            this.snapshot.context.ticketKey
          )}. Paste a frame URL into the ticket and refresh.</div>`
        : '<div class="empty">Loading frames…</div>';
    }

    return this.snapshot.designs.map((frame) => this.frameHtml(frame)).join('\n');
  }

  private frameHtml(frame: DesignFrame): string {
    const src = frame.image && this.view ? this.view.webview.asWebviewUri(frame.image) : undefined;
    const dimensions =
      frame.width && frame.height ? `${Math.round(frame.width)} × ${Math.round(frame.height)}` : frame.type;

    const swatches = frame.colors
      .slice(0, 10)
      .map((c) => `<span class="swatch" style="background:${escapeHtml(c)}" title="${escapeHtml(c)}"></span>`)
      .join('');

    const image = src
      ? `<img class="thumb" src="${src}" alt="${escapeHtml(frame.name)}" data-url="${escapeHtml(frame.url)}">`
      : `<div class="thumb" style="height:80px" data-url="${escapeHtml(frame.url)}"></div>`;

    return `<div class="frame">
  ${image}
  <div class="name" data-url="${escapeHtml(frame.url)}">${escapeHtml(frame.name)}</div>
  <div class="meta">${escapeHtml(dimensions)}</div>
  <div class="swatches">${swatches}</div>
</div>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
