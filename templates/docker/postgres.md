# Disposable PostgreSQL

The environment manager starts `postgres:16-bookworm` on a task-owned internal Docker network with alias `postgres`. No host ports or volumes are published. Data lives in a memory-limited tmpfs and is deleted with the container. Authentication uses a non-secret disposable development password. `pg_isready` and `psql SELECT 1` must both pass before a recovery is accepted. Migrations and application behavior are verified by rerunning the repository's build and test commands.

Images must already be cached unless the user explicitly supplies `--allow-image-pull`. This is a local test database, never a substitute for testing a production database integration.
