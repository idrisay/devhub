/**
 * GitHub serves REST and GraphQL from different paths, and the relationship
 * between them differs between github.com and Enterprise:
 *
 *   github.com   REST https://api.github.com      GraphQL https://api.github.com/graphql
 *   Enterprise   REST https://ghe.corp/api/v3     GraphQL https://ghe.corp/api/graphql
 *
 * So the GraphQL endpoint is derived from the configured REST base rather than
 * being a second setting people have to get right.
 */
export function graphqlEndpoint(restBaseUrl: string): string {
  const trimmed = restBaseUrl.replace(/\/+$/, '');
  if (/^https?:\/\/api\.github\.com$/i.test(trimmed)) {
    return `${trimmed}/graphql`;
  }
  return `${trimmed.replace(/\/api\/v3$/i, '')}/api/graphql`;
}

/** The host whose remotes belong to this GitHub instance. */
export function hostFor(restBaseUrl: string): string {
  const match = restBaseUrl.match(/^https?:\/\/([^/]+)/i);
  if (!match) {
    return 'github.com';
  }
  const host = match[1].toLowerCase();
  return host === 'api.github.com' ? 'github.com' : host;
}
