## Grafana

Create a service account at **Administration → Users and access → Service accounts**, give it the Viewer role, and add a token.

You'll be asked for your Grafana URL — `https://acme.grafana.net` for Grafana Cloud, or wherever your instance lives.

Map each repository to the labels its alerts carry:

```jsonc
{ "devhub.grafana.services": { "acme-web": "service=web" } }
```

Unmapped repositories fall back to matching the repository name against `service`, `app`, `job` and `namespace`.

For **Slowest endpoints**, set `devhub.grafana.latency.datasourceUid` to your Prometheus datasource. If the built-in p95 query doesn't fit your metrics, override `devhub.grafana.latency.query`.
