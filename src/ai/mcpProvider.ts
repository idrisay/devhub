import * as vscode from 'vscode';
import { config } from '../infra/Config';
import { log } from '../infra/Logger';

const FIGMA_LOCAL_MCP = 'http://127.0.0.1:3845/mcp';

/**
 * Figma already ships an MCP server that runs inside the desktop app, so there
 * is no reason to reimplement design-to-code here. Registering it through this
 * provider means the user never has to hand-edit mcp.json, and we can detect
 * whether it's reachable and say so instead of failing silently.
 */
async function isReachable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    await fetch(url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeout);
    return true;
  } catch {
    return false;
  }
}

export function registerMcpProvider(): vscode.Disposable {
  // The API landed in VS Code 1.101. Guard so an older host degrades quietly
  // rather than throwing during activation.
  const lm = vscode.lm as unknown as {
    registerMcpServerDefinitionProvider?: (id: string, provider: unknown) => vscode.Disposable;
  };

  if (typeof lm.registerMcpServerDefinitionProvider !== 'function') {
    log.info('MCP server registration unavailable on this VS Code version; skipping');
    return new vscode.Disposable(() => undefined);
  }

  const emitter = new vscode.EventEmitter<void>();

  const provider = {
    onDidChangeMcpServerDefinitions: emitter.event,
    async provideMcpServerDefinitions(): Promise<unknown[]> {
      if (!config.figma.enabled()) {
        return [];
      }
      if (!(await isReachable(FIGMA_LOCAL_MCP))) {
        log.info('Figma desktop MCP server not reachable — open Figma and enable it in Dev Mode');
        return [];
      }
      const HttpDefinition = (vscode as unknown as {
        McpHttpServerDefinition: new (label: string, uri: vscode.Uri) => unknown;
      }).McpHttpServerDefinition;

      return [new HttpDefinition('Figma Dev Mode', vscode.Uri.parse(FIGMA_LOCAL_MCP))];
    }
  };

  const registration = lm.registerMcpServerDefinitionProvider('devhub.servers', provider);

  return new vscode.Disposable(() => {
    emitter.dispose();
    registration.dispose();
  });
}
