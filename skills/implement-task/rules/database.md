# Database rules

Candidate labels: `database`, `sql`, `schema`, `migration`. Issue types: Task, Bug.
Symptoms: query fix, index/perf, deadlock, schema change, data migration.

## Instructions
- Scope the affected tables/queries first. If the schema changes, write a migration.
- Prefer set-based fixes; keep query semantics (result set) unchanged unless the AC asks otherwise.

## Rules / watch-outs
- Migrations must be reversible and idempotent; include a down/rollback path.
- No destructive drop/truncate without an explicit backup note approved in the ticket.
- Stay within the `dbo` scope; do not touch the `scheduler` (Quartz) schema in convert flows.
- No querying or exporting production DB data (org rule); tests use local/synthetic data only.
- Avoid long-held locks; build indexes online where the engine supports it.
- Verify against the migration report / build before opening the PR.
