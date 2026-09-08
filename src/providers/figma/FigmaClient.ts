import type * as vscode from 'vscode';
import { http } from '../../infra/HttpClient';

export interface FigmaNodeSummary {
  id: string;
  name: string;
  type: string;
  width?: number;
  height?: number;
  /** Flat list of colours used, as hex. */
  colors: string[];
  /** Text styles found in the subtree. */
  typography: string[];
}

interface RawPaint {
  type?: string;
  visible?: boolean;
  color?: { r: number; g: number; b: number };
}

interface RawNode {
  id: string;
  name: string;
  type: string;
  absoluteBoundingBox?: { width: number; height: number };
  fills?: RawPaint[];
  style?: { fontFamily?: string; fontWeight?: number; fontSize?: number };
  children?: RawNode[];
}

function toHex(color: { r: number; g: number; b: number }): string {
  const channel = (v: number) =>
    Math.round(Math.min(Math.max(v, 0), 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`.toUpperCase();
}

function walk(node: RawNode, colors: Set<string>, typography: Set<string>, depth = 0): void {
  if (depth > 12) {
    return;
  }
  for (const fill of node.fills ?? []) {
    if (fill.visible !== false && fill.type === 'SOLID' && fill.color) {
      colors.add(toHex(fill.color));
    }
  }
  if (node.style?.fontFamily) {
    const { fontFamily, fontWeight, fontSize } = node.style;
    typography.add(`${fontFamily} ${fontWeight ?? 400} / ${fontSize ?? '?'}px`);
  }
  for (const child of node.children ?? []) {
    walk(child, colors, typography, depth + 1);
  }
}

export class FigmaClient {
  constructor(private readonly token: string) {}

  private get headers(): Record<string, string> {
    return { 'X-Figma-Token': this.token };
  }

  /** File version is the correct cache key — renders only change when it does. */
  async getFileVersion(fileKey: string, token?: vscode.CancellationToken): Promise<string> {
    const meta = await http.json<{ version: string }>(
      `https://api.figma.com/v1/files/${fileKey}?depth=1`,
      { headers: this.headers, token }
    );
    return meta.version;
  }

  async getNodes(
    fileKey: string,
    nodeIds: string[],
    token?: vscode.CancellationToken
  ): Promise<FigmaNodeSummary[]> {
    const ids = nodeIds.map(encodeURIComponent).join(',');
    const response = await http.json<{
      nodes: Record<string, { document?: RawNode } | null>;
    }>(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${ids}`, {
      headers: this.headers,
      token
    });

    return Object.values(response.nodes ?? {})
      .map((entry) => entry?.document)
      .filter((doc): doc is RawNode => Boolean(doc))
      .map((doc) => {
        const colors = new Set<string>();
        const typography = new Set<string>();
        walk(doc, colors, typography);
        return {
          id: doc.id,
          name: doc.name,
          type: doc.type,
          width: doc.absoluteBoundingBox?.width,
          height: doc.absoluteBoundingBox?.height,
          colors: [...colors].slice(0, 16),
          typography: [...typography].slice(0, 8)
        };
      });
  }

  /**
   * Returns short-lived S3 URLs. They expire within minutes, so callers must
   * download and cache the bytes rather than storing the URL.
   */
  async getImageUrls(
    fileKey: string,
    nodeIds: string[],
    scale = 2,
    token?: vscode.CancellationToken
  ): Promise<Record<string, string>> {
    const ids = nodeIds.map(encodeURIComponent).join(',');
    const response = await http.json<{ images: Record<string, string | null>; err?: string }>(
      `https://api.figma.com/v1/images/${fileKey}?ids=${ids}&format=png&scale=${scale}`,
      { headers: this.headers, token }
    );
    if (response.err) {
      throw new Error(`Figma render failed: ${response.err}`);
    }
    const images: Record<string, string> = {};
    for (const [id, url] of Object.entries(response.images ?? {})) {
      if (url) {
        images[id] = url;
      }
    }
    return images;
  }

  async download(url: string, token?: vscode.CancellationToken): Promise<Uint8Array> {
    return http.buffer(url, { token });
  }

  async verify(token?: vscode.CancellationToken): Promise<string> {
    const me = await http.json<{ handle: string }>('https://api.figma.com/v1/me', {
      headers: this.headers,
      token
    });
    return me.handle;
  }
}
