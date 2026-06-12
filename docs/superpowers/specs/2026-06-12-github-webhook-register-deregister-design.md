# GitHub Webhook Register/Deregister via Nango — Design

**Date:** 2026-06-12
**Status:** Approved
**Context branch:** master (fork: github.com:ryatsuger/nango)

## Problem

marketplace-service is migrating GitHub OAuth token custody to Nango (headless OAuth2,
commit `bd892c43e`). Its existing Go `WebhookLifecycle` implementation
(`~/Projects/marketplace-service/pkg/integration/github/handler.go`) registers, patches,
and deletes repo-level GitHub webhooks directly using tokens it stores itself. Once
tokens live in Nango, that lifecycle must run through Nango instead, and incoming GitHub
events must reach marketplace-service.

Today the plain `github` (User OAuth) provider has no `webhook_routing_script`, so
events sent to Nango's webhook ingress (`POST /webhook/:environmentUuid/:providerConfigKey`)
are swallowed with a 204 and never forwarded (`packages/server/lib/webhook/webhook.manager.ts:55`).

## Decisions made

| Decision | Choice |
|---|---|
| Lifecycle mechanism | Nango **actions** (`register-webhook`, `update-webhook`, `deregister-webhook`) triggered by marketplace-service, plus a `pre-connection-deletion` on-event script as cleanup safety net |
| Provider | `github` (User OAuth), repo-level hooks, target repo passed as action input |
| Event flow | GitHub → Nango ingress → verify → **forward raw payload** to environment webhook URL. No connection mapping, no webhook-subscribed syncs (can be added later) |
| Signature verification | **Shared per-integration secret** in `integration.custom['webhookSecret']`, set by marketplace-service via public API; same pattern as Checkr/Autotask/Calendly |

Rationale for actions over on-event scripts alone: marketplace-service gets synchronous
results (hook ID, errors) from `POST /action/trigger`, enabling its own retry/state
logic. The on-event script covers connections deleted outside marketplace-service
(e.g. dashboard) so no hooks are orphaned.

## Architecture

### 1. Nango server (this fork) — incoming event routing

**New file: `packages/server/lib/webhook/github-webhook-routing.ts`** (exported from
`packages/server/lib/webhook/index.ts` as `githubWebhookRouting`):

- Verify `X-Hub-Signature-256` = HMAC-SHA256(rawBody, `integration.custom['webhookSecret']`),
  timing-safe comparison (model on `github-app-webhook-routing.ts:11-27`).
- Secret configured + signature missing/invalid → `Err(new NangoError('webhook_invalid_signature'))`.
- No secret configured → forward without verification (Calendly convention; in practice
  the secret is always set).
- On success return `{ content: { status: 'success' }, statusCode: 200, connectionIds: [], toForward: body }`.
  Empty `connectionIds` is supported by the forwarder (`packages/webhooks/lib/forward.ts:74`)
  and delivers the raw payload to the environment's primary/secondary webhook URLs as a
  `type: 'forward'` webhook signed with the environment's Nango signing key.
- GitHub `ping` events flow through like any other event (marketplace-service ignores them).

**`packages/providers/providers.yaml`** — on the `github` provider entry (line ~7952) add:

```yaml
webhook_routing_script: githubWebhookRouting
webhook_user_defined_secret: true
```

The second flag exposes the webhook-secret field in the dashboard integration settings
(`GeneralSettings.tsx`); the public API path works regardless.

### 2. Integration scripts — `packages/cli/zzdeploy/github/`

Registered in `packages/cli/zzdeploy/index.ts` via imports, like codex/claude-code.
All GitHub calls go through `nango.proxy()` (token injection, retry handling from
provider yaml). GitHub API failures surface as `ActionError` carrying status + response
body so callers see real errors synchronously.

**`actions/register-webhook.ts`** — mirrors Go `WebhookRegister`:

- Input: `{ owner: string, repo: string, events: string[], callback_url: string, secret: string }`
  - `callback_url`: the Nango ingress URL `{nangoHost}/webhook/{environmentUuid}/github`
    (marketplace-service owns and passes it).
  - `secret`: the shared integration secret (marketplace-service owns and passes it).
- Calls `POST /repos/{owner}/{repo}/hooks` with
  `{ name: 'web', active: true, events, config: { url, content_type: 'json', secret, insecure_ssl: '0' } }`.
- Output: `{ hookId: string }`.
- Bookkeeping: append `{ owner, repo, hookId }` to connection metadata key
  `registeredWebhooks`. If the metadata write fails after hook creation, best-effort
  delete the just-created hook, then return the error (no silent orphan).

**`actions/update-webhook.ts`** — mirrors Go `WebhookPatch`:

- Input: `{ owner: string, repo: string, hookId: string, events: string[] }`.
- `PATCH /repos/{owner}/{repo}/hooks/{hookId}` with `{ events }` (full replacement —
  repo hooks don't support add/remove deltas).
- Empty `events` input is rejected by validation (GitHub requires at least one).

**`actions/deregister-webhook.ts`** — mirrors Go `WebhookDelete`:

- Input: `{ owner: string, repo: string, hookId: string }`.
- `DELETE /repos/{owner}/{repo}/hooks/{hookId}`; treat 404 as success (idempotent).
- Remove the matching entry from `registeredWebhooks` metadata.

**`on-events/pre-connection-deletion.ts`** — safety net:

- Read `metadata.registeredWebhooks`; for each entry, best-effort
  `DELETE /repos/{owner}/{repo}/hooks/{hookId}` (404 = fine).
- Log and continue on failure; never block connection deletion.

### 3. marketplace-service responsibilities (documented here, implemented there)

- One-time per integration: generate the shared HMAC secret; store it via
  `PATCH /integrations/github` with `credentials.webhook_secret` (lands in
  `integration.custom['webhookSecret']`,
  `packages/server/lib/controllers/integrations/uniqueKey/patchIntegration.ts:142`).
  Configure the environment webhook forward URL to its receiver endpoint.
- Per repo: trigger the actions via `POST /action/trigger` with the connection ID,
  passing `callback_url` and `secret`.
- Connect-time: request `admin:repo_hook` in OAuth scopes (equivalent of Go
  `RequireScope`); registration fails with a GitHub 403/404 otherwise.
- Consume forwarded events at its receiver, verifying Nango's forwarding signature
  (raw GitHub payload is preserved in `payload`).

## Error handling summary

| Failure | Behavior |
|---|---|
| GitHub API error during register/update/deregister | `ActionError` with status + body returned to caller; nothing persisted |
| Metadata write fails after hook created | Compensating hook delete, then error |
| Deregister of already-deleted hook | 404 treated as success |
| Invalid/missing signature at ingress (secret set) | Request rejected, nothing forwarded |
| Pre-deletion cleanup failure | Logged, deletion proceeds |

## Out of scope

- Webhook-subscribed syncs / connection mapping for incoming events (possible later;
  would match `repository.full_name` or `X-GitHub-Hook-ID` against registration-time
  connection state, behind the same routing script).
- Org-level webhooks and GitHub App hooks (github-app routing already exists).
- Per-hook secrets (rotating the shared secret means re-PATCHing existing hooks via
  `update-webhook` — accepted trade-off).
- Automatic registration on connection creation (marketplace-service drives explicitly).

## Testing

- **Routing script:** unit tests modeled on `autotask-webhook-routing.unit.test.ts` —
  valid signature forwards; invalid/missing signature rejected when secret set;
  no-secret passthrough; response shape (`connectionIds: []`, `toForward`).
- **Actions:** `nango dryrun` against a test repo — register returns hook ID and writes
  metadata; update replaces events; deregister twice (idempotency); register with bad
  scope surfaces GitHub error.
- **End-to-end:** register a hook on a test repo pointing at a dev Nango instance,
  push an event, confirm forward arrives at the configured webhook URL with raw payload.
