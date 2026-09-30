# Local Vercel service simulator

This repository now contains a Vercel-compatible Node Function entrypoint and a local HTTP runner that invokes the same handler. It simulates the **Function/API boundary**, PostgreSQL persistence, leases, idempotent submission, and a local in-process workflow runner. It does not emulate Vercel's control plane or provide a local implementation of Vercel Workflow internals.

## Start locally

PostgreSQL is required:

```sh
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/pi_poc
pnpm run local:vercel
```

Optional variables:

```sh
PORT=3000
LOCAL_AGENT_RESPONSE="local response"
PG_POOL_MAX=4
```

The local model is deterministic and uses `pi-ai`'s faux provider. It is intended to validate service wiring without an LLM credential.

## Smoke test

```sh
curl http://localhost:3000/api/health

SESSION=$(curl -s -X POST http://localhost:3000/api/sessions \
  -H 'content-type: application/json' \
  -d '{}' | jq -r .session.id)

SUBMISSION=$(curl -s -X POST "http://localhost:3000/api/sessions/$SESSION/messages" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: local-request-1' \
  -d '{"content":"hello"}')
SUBMISSION_ID=$(printf '%s' "$SUBMISSION" | jq -r .submission.id)
echo "$SUBMISSION"
```

The POST returns `202`. In local mode the in-process workflow runner drives the operation in the background. Read the submission and result using the returned `submission.id`:

```sh
curl "http://localhost:3000/api/submissions/$SUBMISSION_ID"
curl "http://localhost:3000/api/submissions/$SUBMISSION_ID/result"
```

Supported routes:

- `GET /api/health`
- `POST /api/sessions`
- `POST /api/sessions/:sessionId/messages`
- `GET /api/submissions/:submissionId`
- `GET /api/submissions/:submissionId/result`
- `POST /api/submissions/:submissionId/cancel`
- `POST /api/internal/agent-drive` (workflow/queue adapter; requires `WORKFLOW_START_TOKEN`)

Local authentication defaults to `local-user` / `local-tenant`. Custom test identities can use `x-user-id`, `x-tenant-id`, and `x-scopes` headers.

## Vercel deployment shape

`api/index.ts` is the Node Function entrypoint. `vercel.json` rewrites `/api/*` to that function. Set at least:

```sh
DATABASE_URL=...
WORKFLOW_START_URL=...
WORKFLOW_START_TOKEN=...
```

Vercel mode rejects requests when `WORKFLOW_START_URL` is absent instead of silently running an in-process background task. The URL must point to a real durable workflow starter or queue adapter; the repository does not pretend to emulate that control plane locally. A queue/workflow adapter can invoke `POST /api/internal/agent-drive` with the identity-only workflow payload and repeat until it receives `completed`.

The current auth resolver is a development header adapter. Replace it with the deployment's identity provider before exposing the function publicly. Likewise, replace the deterministic faux model factory with the production model/provider factory.

Schema creation is currently lazy and guarded by a PostgreSQL advisory lock for PoC convenience. Production should run the schema through a deployment migration job and remove request-path DDL.
