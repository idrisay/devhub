export interface FigmaRef {
  fileKey: string;
  /** API form, using a colon: `123:456`. URLs use a hyphen. */
  nodeId?: string;
  url: string;
}

const FIGMA_URL_SOURCE =
  String.raw`https?://(?:www\.)?figma\.com/(?:file|design|proto|board)/([A-Za-z0-9]+)(?:/[^?\s]*)?(?:\?([^\s<>"']*))?`;

/** Fresh instance per call — a shared global regex with lastIndex is a footgun. */
function figmaUrlPattern(): RegExp {
  return new RegExp(FIGMA_URL_SOURCE, 'gi');
}

/**
 * Node ids appear as `1-234` in URLs but the REST API expects `1:234`. Getting
 * this backwards is the most common reason a frame lookup returns nothing.
 */
export function normaliseNodeId(raw: string | null | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const decoded = decodeURIComponent(raw).trim();
  return decoded.replace(/-/g, ':') || undefined;
}

export function parseFigmaUrl(url: string): FigmaRef | undefined {
  const match = figmaUrlPattern().exec(url);
  if (!match) {
    return undefined;
  }
  const [, fileKey, query] = match;
  const params = new URLSearchParams(query ?? '');
  return {
    fileKey,
    nodeId: normaliseNodeId(params.get('node-id')),
    url: match[0]
  };
}

/** Pulls every distinct Figma reference out of a block of text. */
export function extractFigmaRefs(text: string): FigmaRef[] {
  const refs = new Map<string, FigmaRef>();
  const pattern = figmaUrlPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const ref = parseFigmaUrl(match[0]);
    if (ref) {
      refs.set(`${ref.fileKey}:${ref.nodeId ?? 'root'}`, ref);
    }
  }
  return [...refs.values()];
}
