import type { JiraTransition } from './JiraClient';

/**
 * Picks the transition to offer after `Start work on issue`.
 *
 * Jira workflows are per-project configuration, so there is no reliable name to
 * look for. `configured` is the escape hatch (`devhub.jira.inProgressTransition`):
 * when set it matches the transition's own name *or* the status it moves to,
 * because the two differ often enough — a transition called "Start progress"
 * that lands on "In Progress" is matched by either word.
 *
 * With nothing configured, fall back to the names that are conventional.
 */
export function findInProgressTransition(
  transitions: readonly JiraTransition[],
  configured = ''
): JiraTransition | undefined {
  const wanted = configured.trim().toLowerCase();
  if (wanted) {
    return transitions.find(
      (t) => t.name.toLowerCase() === wanted || t.to.toLowerCase() === wanted
    );
  }
  return transitions.find((t) => /in progress|start|doing/i.test(t.name));
}
