# Quiz Autopilot sync server (Vercel)

Stores the Quiz Autopilot question bank so every computer with the add-on shares the same questions and answers.

- `api/questions.js`: `GET` returns the bank (`?rev=N` returns `{unchanged:true}` when nothing changed). `POST {upsert, delete}` saves changes, and the newer answer wins. Needs `Authorization: Bearer <BANK_TOKEN>`.
- `api/health.js`: setup check used by the status page (`public/index.html`).
- `lib/store.js`: Upstash Redis over its REST API, with no npm packages. `BANK_STORE=memory` keeps data in memory for local testing.

**Setup:** deploy this folder to Vercel (Root Directory `tools/chamilo-quiz-autopilot/server`), add **Upstash Redis** under Storage, set a `BANK_TOKEN` environment variable, then redeploy. The step-by-step guide is in [../README.md](../README.md#cloud-sync-with-vercel-same-questions-on-every-computer).

**Tests:** `npm test` runs the API against a fake Upstash server.
