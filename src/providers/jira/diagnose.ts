/**
 * Turns whatever a Jira call threw into something the user can act on.
 *
 * Errors are matched by shape rather than by `instanceof` so this module stays
 * free of `vscode` imports and can be exercised from test/smoke.ts.
 */

export type JiraFailureHealth = 'auth-expired' | 'rate-limited' | 'error';

export interface JiraFailure {
  health: JiraFailureHealth;
  /** Short enough for a tree item description. */
  summary: string;
  /** The full explanation, for notifications and tooltips. */
  message: string;
}

export interface JiraTarget {
  baseUrl: string;
  email: string;
}

interface ErrorShape {
  name?: string;
  status?: number;
  message?: string;
  body?: string;
  contentType?: string;
  snippet?: string;
  deniedReason?: string;
  ms?: number;
}

export function diagnoseJiraFailure(err: unknown, target: JiraTarget): JiraFailure {
  const e = (err ?? {}) as ErrorShape;
  const site = target.baseUrl || 'the configured Jira site';

  if (e.name === 'CancelledError') {
    return { health: 'error', summary: 'Cancelled', message: 'The Jira request was cancelled.' };
  }

  if (e.name === 'TimeoutError') {
    const seconds = Math.max(1, Math.round((e.ms ?? 0) / 1000));
    return {
      health: 'error',
      summary: 'No response',
      message:
        `${site} did not respond within ${seconds}s. Check devhub.jira.baseUrl, ` +
        'and whether reaching this site needs a VPN or proxy.'
    };
  }

  if (e.name === 'NonJsonResponseError') {
    return {
      health: 'error',
      summary: 'Not a Jira API',
      message:
        `${site} answered with ${e.contentType || 'a non-JSON response'} instead of JSON. ` +
        'That almost always means devhub.jira.baseUrl points at an SSO or login page rather ' +
        'than a Jira site root such as https://acme.atlassian.net.'
    };
  }

  switch (e.status) {
    case 401:
      return {
        health: 'auth-expired',
        summary: 'Credentials rejected (401)',
        message:
          'Jira rejected the credentials (401). Jira Cloud wants your Atlassian account email ' +
          'as the username and the API token as the password, so check that devhub.jira.email ' +
          `(${target.email || 'not set'}) is the account the token was created under, and that ` +
          'the token has not been revoked.'
      };

    case 403: {
      const captcha = /captcha/i.test(`${e.deniedReason ?? ''} ${e.body ?? ''}`);
      return {
        health: 'auth-expired',
        summary: captcha ? 'CAPTCHA required (403)' : 'Request refused (403)',
        message: captcha
          ? `Jira is demanding a CAPTCHA (403), which it does after repeated failed logins. ` +
            `Open ${site} in a browser, sign in to clear the challenge, then reconnect.`
          : 'Jira accepted the credentials but refused the request (403). Either the token is ' +
            'missing the scopes needed to read issues, or Atlassian has flagged the account and ' +
            `wants a CAPTCHA — open ${site} in a browser, sign in, then reconnect.`
      };
    }

    case 404:
      return {
        health: 'error',
        summary: 'API not found (404)',
        message:
          `There is no Jira REST API at ${site}/rest/api/3/myself (404). Check that ` +
          'devhub.jira.baseUrl is the site root. A 404 here also means a Jira Server or Data ' +
          'Center instance, which serves /rest/api/2 and authenticates with a Bearer personal ' +
          'access token — DevHub only speaks Jira Cloud.'
      };

    case 429:
      return {
        health: 'rate-limited',
        summary: 'Rate limited (429)',
        message: 'Jira is rate limiting DevHub (429). Wait a moment and try again.'
      };
  }

  if (typeof e.status === 'number' && e.status >= 500) {
    return {
      health: 'error',
      summary: `Jira unavailable (${e.status})`,
      message: `${site} returned HTTP ${e.status}. That is a fault on the Jira side — retry shortly.`
    };
  }

  return {
    health: 'error',
    summary: 'Request failed',
    message: e.message ? `Jira request failed: ${e.message}` : 'Jira request failed for an unknown reason.'
  };
}
