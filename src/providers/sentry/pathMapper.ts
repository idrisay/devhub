import * as path from 'path';
import type { PathMapping } from '../../infra/Config';

/**
 * Sentry stack frames carry filenames like `app:///src/auth/login.ts` or
 * `webpack://myapp/./src/auth/login.ts`. Turning those into a real path on disk
 * is the single most fragile part of the integration, so it lives here on its
 * own and is a pure function: no vscode, no I/O, trivially testable.
 */

const BUILTIN_PREFIXES = [
  'app:///',
  'app://',
  'file://',
  'webpack-internal:///',
  'webpack:///',
  '/_next/'
];

export function applyMappings(filename: string, mappings: PathMapping[]): string {
  let result = filename;
  for (const mapping of mappings) {
    if (mapping.from && result.startsWith(mapping.from)) {
      result = mapping.to + result.slice(mapping.from.length);
    }
  }
  for (const prefix of BUILTIN_PREFIXES) {
    if (result.startsWith(prefix)) {
      result = result.slice(prefix.length);
    }
  }
  // Bundlers frequently emit `./` and `~/` roots.
  result = result.replace(/^\.\//, '').replace(/^~\//, '');
  return result;
}

export interface ResolveOptions {
  repoRoot: string;
  mappings: PathMapping[];
  /** Absolute paths of files known to exist. Used to disambiguate suffix matches. */
  knownFiles?: string[];
}

/**
 * Returns an absolute path, or undefined when the frame can't be placed
 * confidently. Dropping a frame silently is correct — a diagnostic pinned to the
 * wrong file is worse than no diagnostic.
 */
export function resolveFrame(filename: string, options: ResolveOptions): string | undefined {
  if (!filename) {
    return undefined;
  }

  const mapped = applyMappings(filename, options.mappings);

  if (path.isAbsolute(mapped)) {
    return mapped.startsWith(options.repoRoot) ? mapped : undefined;
  }

  const direct = path.join(options.repoRoot, mapped);

  if (!options.knownFiles?.length) {
    return direct;
  }

  if (options.knownFiles.includes(direct)) {
    return direct;
  }

  // Fall back to a longest-suffix match, but only when it is unambiguous.
  const normalised = mapped.split(/[\\/]/).filter(Boolean);
  const candidates = options.knownFiles.filter((file) => {
    const parts = file.split(path.sep);
    return normalised.every((segment, i) => parts[parts.length - normalised.length + i] === segment);
  });

  return candidates.length === 1 ? candidates[0] : undefined;
}

/** True when a frame belongs to the user's own code rather than a dependency. */
export function isAppFrame(frame: { in_app?: boolean; filename?: string }): boolean {
  if (frame.in_app === false) {
    return false;
  }
  return !/node_modules|\/dist\/|\.min\.js$/.test(frame.filename ?? '');
}
