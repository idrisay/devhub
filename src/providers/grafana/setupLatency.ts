import * as vscode from 'vscode';
import { config } from '../../infra/Config';
import { log } from '../../infra/Logger';
import type { Hub } from '../Hub';
import { repoNameOf } from './GrafanaProvider';
import {
  buildLatencyQuery,
  rankGroupLabels,
  rankMetrics,
  renderLatencyQuery,
  type LatencyCandidate
} from './latencyQuery';
import { toPromSelector } from './serviceScope';
import {
  buildLokiLatencyQuery,
  detectFormat,
  fieldsFrom,
  guessUnit,
  rankDurationFields,
  rankRouteFields,
  type DurationUnit
} from './logFields';

const SETTINGS = vscode.ConfigurationTarget.Global;

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('devhub');
}

/**
 * Walks the user from "the latency query returned nothing" to a query that
 * returns something, using the token DevHub already holds.
 *
 * The alternative was a settings field asking for a metric name the user has
 * no way to look up from inside the editor — which is exactly where this
 * feature kept stalling.
 */
export async function setupLatency(hub: Hub): Promise<void> {
  if (!config.grafana.baseUrl()) {
    const choice = await vscode.window.showWarningMessage(
      'DevHub: connect Grafana first.',
      'Connect a service'
    );
    if (choice) {
      await vscode.commands.executeCommand('devhub.signIn', 'grafana');
    }
    return;
  }

  const source = new vscode.CancellationTokenSource();
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'DevHub: setting up latency' },
      async (progress) => {
        const uid = await pickDatasource(hub, source.token, progress);
        if (!uid) {
          return;
        }

        progress.report({ message: 'looking for latency metrics…' });
        const { candidates, total, sample } = await hub.grafana.latencyMetrics(uid, source.token);
        if (candidates.length === 0) {
          log.info(`Grafana: no latency metrics among ${total} in ${uid}`);
          // Metrics are the better source, but plenty of stacks only ship
          // access logs — and a duration field in those answers the same
          // question without instrumenting anything.
          const choice = await vscode.window.showWarningMessage(
            `DevHub: none of the ${total} metric(s) in this datasource can produce a latency figure — ` +
              'no histogram buckets, and no _sum/_count pair to average. ' +
              (sample.length > 0
                ? 'The closest names are in the log.'
                : 'Nothing there is even named like a duration.'),
            'Try Loki logs',
            'Show logs'
          );
          if (choice === 'Show logs') {
            log.show();
          } else if (choice === 'Try Loki logs') {
            await setupFromLoki(hub, progress, source.token);
          }
          return;
        }

        const ranked = rankCandidates(candidates);
        // A datasource can have candidates that are all useless — a Go runtime
        // histogram is still a histogram — so the way out has to be in the
        // picker itself, not behind a "found nothing at all" branch.
        const chosen = await vscode.window.showQuickPick(
          [
            ...ranked.map((candidate) => ({
              label: candidate.metric,
              description: candidate.kind === 'histogram' ? 'p95' : 'average · no buckets',
              candidate: candidate as LatencyCandidate | undefined
            })),
            {
              label: 'None of these — build it from Loki logs instead',
              description: 'read durations out of access logs',
              candidate: undefined
            }
          ],
          {
            title: 'DevHub — which metric measures request duration?',
            placeHolder: `${candidates.length} candidate(s) out of ${total} metric(s)`,
            matchOnDescription: true
          }
        );
        if (!chosen) {
          return;
        }
        if (!chosen.candidate) {
          await setupFromLoki(hub, progress, source.token);
          return;
        }
        const { metric, kind } = chosen.candidate;

        progress.report({ message: 'reading its labels…' });
        const labelSource = kind === 'average' ? `${metric}_count` : metric;
        const labels = rankGroupLabels(
          await hub.grafana.metricLabels(uid, labelSource, source.token)
        );
        if (labels.length === 0) {
          void vscode.window.showWarningMessage(
            `DevHub: ${labelSource} carries no label that could name an endpoint.`
          );
          return;
        }

        const groupBy = await pick(labels, 'Which label names the endpoint?', labelSource);
        if (!groupBy) {
          return;
        }

        const query = buildLatencyQuery(metric, groupBy, kind);
        await settings().update('grafana.latency.query', query, SETTINGS);
        await settings().update('grafana.latency.datasourceKind', 'prometheus', SETTINGS);

        progress.report({ message: 'checking the service scope…' });
        await verifyScope(hub, uid, metric, labelSource, query, source.token);
      }
    );
  } catch (err) {
    log.error('Latency setup failed', err);
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window
      .showErrorMessage(`DevHub: ${message}`, 'Show logs')
      .then((choice) => choice === 'Show logs' && log.show());
    return;
  } finally {
    source.dispose();
  }

  await hub.refresh();
}

async function pickDatasource(
  hub: Hub,
  token: vscode.CancellationToken,
  progress: vscode.Progress<{ message?: string }>
): Promise<string | undefined> {
  const existing = config.grafana.latency.datasourceUid();
  if (existing) {
    return existing;
  }

  progress.report({ message: 'listing datasources…' });
  const datasources = await hub.grafana.datasources(token);
  if (datasources.length === 0) {
    void vscode.window.showWarningMessage(
      'DevHub: the token can see no Prometheus datasources in this Grafana.'
    );
    return undefined;
  }

  const picked =
    datasources.length === 1
      ? datasources[0]
      : (
          await vscode.window.showQuickPick(
            datasources.map((ds) => ({
              label: ds.name,
              description: ds.uid + (ds.isDefault ? ' · default' : ''),
              ds
            })),
            { title: 'DevHub — which Prometheus holds your request metrics?' }
          )
        )?.ds;

  if (!picked) {
    return undefined;
  }
  await settings().update('grafana.latency.datasourceUid', picked.uid, SETTINGS);
  return picked.uid;
}

/**
 * Builds the latency query out of log lines instead of metrics: pick a stream,
 * read a few lines from it, work out how they are structured, and let the user
 * name the duration and route fields from what is actually in them.
 */
async function setupFromLoki(
  hub: Hub,
  progress: vscode.Progress<{ message?: string }>,
  token: vscode.CancellationToken
): Promise<void> {
  progress.report({ message: 'looking for Loki…' });
  const datasources = await hub.grafana.lokiDatasources(token);
  if (datasources.length === 0) {
    void vscode.window.showWarningMessage(
      'DevHub: no Loki datasource in this Grafana, so there are no logs to read durations from either.'
    );
    return;
  }

  const ds =
    datasources.length === 1
      ? datasources[0]
      : (
          await vscode.window.showQuickPick(
            datasources.map((d) => ({ label: d.name, description: d.uid, d })),
            { title: 'DevHub — which Loki holds your access logs?' }
          )
        )?.d;
  if (!ds) {
    return;
  }

  progress.report({ message: 'reading stream labels…' });
  const labels = await hub.grafana.lokiLabels(ds.uid, token);
  if (labels.length === 0) {
    void vscode.window.showWarningMessage(`DevHub: ${ds.name} has no stream labels in the last 6h.`);
    return;
  }

  const label = await pick(labels, 'Which label picks out the service?', ds.name);
  if (!label) {
    return;
  }

  progress.report({ message: `reading ${label} values…` });
  const values = await hub.grafana.lokiLabelValues(ds.uid, label, token);
  if (values.length === 0) {
    void vscode.window.showWarningMessage(`DevHub: ${label} has no values in the last 6h.`);
    return;
  }
  const value = await pick(values.sort(), `Which ${label} is your API?`, ds.name);
  if (!value) {
    return;
  }

  const selector = `{${label}="${value}"}`;
  progress.report({ message: 'sampling log lines…' });
  const lines = await hub.grafana.lokiSample(ds.uid, selector, token);
  if (lines.length === 0) {
    void vscode.window.showWarningMessage(`DevHub: no log lines in ${selector} over the last 6h.`);
    return;
  }

  const format = detectFormat(lines);
  if (format === 'unknown') {
    // Without a parser stage there are no fields to unwrap, and guessing at a
    // regex from 25 lines would be worse than saying so.
    void vscode.window
      .showWarningMessage(
        `DevHub: the lines in ${selector} are neither JSON nor logfmt, so there are no fields to read a duration from. A sample is in the log.`,
        'Show logs'
      )
      .then((choice) => choice === 'Show logs' && log.show());
    log.info(`Loki sample from ${selector}:\n${lines.slice(0, 5).join('\n')}`);
    return;
  }

  const fields = fieldsFrom(lines, format);
  const durations = rankDurationFields(fields);
  if (durations.length === 0) {
    void vscode.window.showWarningMessage(
      `DevHub: ${selector} parses as ${format}, but none of its ${fields.size} field(s) hold a number that could be a duration.`
    );
    log.info(`Loki ${format} fields in ${selector}: ${[...fields.keys()].join(', ')}`);
    return;
  }

  const durationField = await pick(durations, 'Which field is the request duration?', format);
  if (!durationField) {
    return;
  }

  const routes = rankRouteFields(fields);
  if (routes.length === 0) {
    void vscode.window.showWarningMessage(
      `DevHub: no text field in ${selector} could name an endpoint to group by.`
    );
    return;
  }
  const routeField = await pick(routes, 'Which field is the route?', format);
  if (!routeField) {
    return;
  }

  const guessed = guessUnit(fields.get(durationField) ?? []);
  const unitPick = await vscode.window.showQuickPick(
    (['seconds', 'milliseconds'] as DurationUnit[])
      .sort((a) => (a === guessed ? -1 : 1))
      .map((unit) => ({
        label: unit,
        description: unit === guessed ? 'guessed from the sampled values' : undefined
      })),
    { title: `DevHub — what unit is ${durationField} in?` }
  );
  if (!unitPick) {
    return;
  }

  const query = buildLokiLatencyQuery({
    selector,
    format,
    durationField,
    routeField,
    unit: unitPick.label as DurationUnit
  });

  await settings().update('grafana.latency.datasourceUid', ds.uid, SETTINGS);
  await settings().update('grafana.latency.datasourceKind', 'loki', SETTINGS);
  await settings().update('grafana.latency.query', query, SETTINGS);

  progress.report({ message: 'checking the query…' });
  const found = await hub.grafana.probe(
    ds.uid,
    renderLatencyQuery(query, {
      selector: '',
      window: config.grafana.latency.window(),
      limit: config.grafana.latency.limit(),
      service: ''
    }),
    token,
    'loki'
  );
  void (found > 0
    ? vscode.window.showInformationMessage(`DevHub: ${found} endpoint(s) found in ${selector}.`)
    : vscode.window.showWarningMessage(
        `DevHub: the query built cleanly but returned nothing over the last ${config.grafana.latency.window()}. Widen devhub.grafana.latency.window.`
      ));
}

/** Ranks candidates by name, keeping real histograms ahead of averages. */
function rankCandidates(candidates: LatencyCandidate[]): LatencyCandidate[] {
  const order = rankMetrics(candidates.map((c) => c.metric));
  return [...candidates].sort(
    (a, b) =>
      Number(a.kind === 'average') - Number(b.kind === 'average') ||
      order.indexOf(a.metric) - order.indexOf(b.metric)
  );
}

async function pick(
  items: string[],
  title: string,
  detail: string
): Promise<string | undefined> {
  return vscode.window.showQuickPick(items, {
    title: `DevHub — ${title}`,
    placeHolder: detail,
    matchOnDetail: true
  });
}

/**
 * A right query still returns nothing if it is scoped to a service label value
 * that doesn't exist — which is what the repository-name guess produces most of
 * the time. Test both, and only blame the scope when dropping it helps.
 */
async function verifyScope(
  hub: Hub,
  uid: string,
  metric: string,
  /** The series to read labels off: an average's base name is not one. */
  labelSource: string,
  query: string,
  token: vscode.CancellationToken
): Promise<void> {
  const ctx = hub.current.context;
  const scope = hub.grafana.scope(ctx);
  const vars = {
    window: config.grafana.latency.window(),
    limit: config.grafana.latency.limit(),
    service: repoNameOf(ctx) ?? ''
  };

  const scoped = await hub.grafana.probe(
    uid,
    renderLatencyQuery(query, { ...vars, selector: toPromSelector(scope.matchers) }),
    token
  );
  if (scoped > 0) {
    void vscode.window.showInformationMessage(`DevHub: ${scoped} endpoint(s) found.`);
    return;
  }

  const unscoped = await hub.grafana.probe(
    uid,
    renderLatencyQuery(query, { ...vars, selector: '' }),
    token
  );
  if (unscoped === 0) {
    void vscode.window.showWarningMessage(
      `DevHub: ${metric} exists but has no data in the last ${vars.window}. Widen devhub.grafana.latency.window, or pick a different metric.`
    );
    return;
  }

  const repoName = repoNameOf(ctx);
  const selectorText = scope.matchers.map((m) => `${m.label}=${m.value}`).join(', ');
  const choice = await vscode.window.showWarningMessage(
    `DevHub: the metric has data, but nothing matches ${selectorText || 'the current scope'}. Pick the label that identifies ${repoName ?? 'this service'}?`,
    'Pick label',
    'Show everything'
  );

  if (choice === 'Show everything') {
    // An explicit empty mapping is how a repository says "don't scope me",
    // and it stops the repository-name guess from coming back.
    await updateServices(repoName, '');
    return;
  }
  if (choice !== 'Pick label' || !repoName) {
    return;
  }

  const labelNames = await hub.grafana.metricLabels(uid, labelSource, token);
  const candidates = config.grafana
    .serviceLabels()
    .filter((label) => labelNames.includes(label))
    .concat(labelNames.filter((name) => !name.startsWith('__') && name !== 'le'));

  const label = await pick([...new Set(candidates)], 'Which label identifies the service?', labelSource);
  if (!label) {
    return;
  }

  const values = await hub.grafana.metricLabelValues(uid, labelSource, label, token);
  if (values.length === 0) {
    void vscode.window.showWarningMessage(`DevHub: ${label} has no values on ${labelSource}.`);
    return;
  }
  const value = await pick(values.sort(), `Which ${label} is ${repoName}?`, labelSource);
  if (!value) {
    return;
  }

  await updateServices(repoName, `${label}=${value}`);
  void vscode.window.showInformationMessage(
    `DevHub: ${repoName} scoped to ${label}=${value}.`
  );
}

/**
 * Fixes the alert scope by picking from the labels the firing alerts actually
 * carry. Needs no network: the facets come from the last fetch.
 */
export async function setupAlertScope(hub: Hub): Promise<void> {
  const facets = hub.grafana.alertLabelFacets();
  if (facets.size === 0) {
    void vscode.window.showInformationMessage(
      'DevHub: no alerts are firing in Grafana at all, so there is nothing to scope to.'
    );
    return;
  }

  const repoName = repoNameOf(hub.current.context);
  if (!repoName) {
    void vscode.window.showWarningMessage('DevHub: open a Git repository to scope alerts to it.');
    return;
  }

  const preferred = config.grafana.serviceLabels();
  const labels = [...facets.keys()].sort(
    (a, b) =>
      (preferred.indexOf(a) === -1 ? preferred.length : preferred.indexOf(a)) -
        (preferred.indexOf(b) === -1 ? preferred.length : preferred.indexOf(b)) ||
      a.localeCompare(b)
  );

  const label = await vscode.window.showQuickPick(
    labels.map((name) => ({
      label: name,
      description: `${facets.get(name)?.size ?? 0} value(s)`
    })),
    { title: `DevHub — which label identifies ${repoName}?` }
  );
  if (!label) {
    return;
  }

  const value = await vscode.window.showQuickPick(
    [...(facets.get(label.label) ?? [])].sort(),
    { title: `DevHub — which ${label.label} is ${repoName}?` }
  );
  if (!value) {
    return;
  }

  await updateServices(repoName, `${label.label}=${value}`);
  await hub.refresh();
  void vscode.window.showInformationMessage(
    `DevHub: ${repoName} scoped to ${label.label}=${value}.`
  );
}

async function updateServices(repoName: string | undefined, selector: string): Promise<void> {
  if (!repoName) {
    return;
  }
  const current = { ...config.grafana.services() };
  current[repoName] = selector;
  await settings().update('grafana.services', current, SETTINGS);
}
