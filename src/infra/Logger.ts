import * as vscode from 'vscode';

const SECRET_PATTERNS: RegExp[] = [
  /(Authorization"?\s*[:=]\s*"?)([^"\s,}]+)/gi,
  /(Bearer\s+)([A-Za-z0-9._\-]+)/g,
  /(Basic\s+)([A-Za-z0-9+/=]+)/g,
  /(token"?\s*[:=]\s*"?)([^"\s,}]+)/gi
];

/** Scrub anything credential-shaped before it can reach the output channel. */
export function redact(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_m, prefix: string) => `${prefix}<redacted>`);
  }
  return out;
}

export class Logger {
  private readonly channel: vscode.LogOutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel('DevHub', { log: true });
  }

  info(message: string): void {
    this.channel.info(redact(message));
  }

  warn(message: string): void {
    this.channel.warn(redact(message));
  }

  error(message: string, err?: unknown): void {
    const detail = err instanceof Error ? err.message : err ? String(err) : '';
    this.channel.error(redact(detail ? `${message}: ${detail}` : message));
  }

  show(): void {
    this.channel.show();
  }

  dispose(): void {
    this.channel.dispose();
  }
}

export const log = new Logger();
