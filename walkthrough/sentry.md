## Sentry

Create an auth token at **Settings → Account → API → Auth Tokens** with `project:read` and `event:read`.

Set `devhub.sentry.organization` to your org slug. Projects are auto-detected, or set `devhub.sentry.projects` to narrow them.

If errors appear in the tree but no squiggles appear in files, run **DevHub: Diagnose Sentry path mapping…** and add a rewrite to `devhub.sentry.pathMappings`.
