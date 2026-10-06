---
part: Features
status: verified
updated: 2026-10-06
---

# Durable model completions for Obsidian Vault Notes

`PUT /obsidian-completions/:id` accepts a client-generated UUID, a permitted model endpoint and the OpenAI completion payload. `GET /obsidian-completions/:id` fetches status and the saved response. Requests follow the service's existing project/username tracking middleware; the UUID is also required to retrieve the job. These headers are application scoping, not a new authentication mechanism.

The endpoint permits only the existing Jetson and Gold Spark text servers and limits concurrent jobs to eight. It writes an acceptance record before returning HTTP 202 and starts one bounded, non-streaming model request. Disconnecting the initiating HTTP client does not cancel inference. The identical UUID and payload return the existing job, while a changed payload with that UUID is rejected.

Jobs are scoped by project/username and stored in `obsidian-completions/` beside the configured runtime store. On the NAS this is inside the mounted `runtime-data` directory. Completion and failure outcomes are saved using a temporary file and rename. If the process restarts during a running job, retrieval records a failure explaining the interruption; it does not replay the model request. Results currently remain on disk until explicitly removed by the operator.

The plugin owns the agent loop and vault tools. A model step finishes on this service while Obsidian is closed; subsequent vault operations continue when Obsidian reopens. No Prism repository changes are required.

Validation covers persisted acceptance before transport completion, duplicate PUTs with a single model call, durable result retrieval from a second store, scope isolation, mismatched request rejection, endpoint/ID validation and interrupted jobs without replay. The runtime TypeScript build must pass. Deploy from deploy-kit using the existing `lazy-tool-service` registry ID and verify `/health` and an accepted/completed model job after restart.
