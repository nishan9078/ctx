# ADR-012: Private local Sentinel IPC and software-only wakeups

Status: accepted for the tested Linux daemon contract. Schema and adapter versions unchanged.

Sentinel owns the durable scheduler independently of UI connections. Startup and idle cycles reuse existing reconciliation and persisted next-run timestamps; no second scheduling store or idle model loop is introduced. Submission commits before acknowledgement, and deduplication handles disconnected clients. The outbox remains pending for Phase 09 delivery.

The Linux launcher uses a kernel flock held across exec to prevent duplicate daemons, then safely removes only the prior owner socket. Private owner-only Unix socket and token files authenticate bounded versioned JSON requests. The trusted ingress fixes principal/source/destination; submitted descriptions cannot grant authority. Future Discord ingress requires a separate authenticated mapping. No loopback TCP port is opened.

The loop wakes immediately on accepted commands and at durable deadlines, with a bounded fallback poll for external database changes. Observable state reflects local execution and held durable leases, persisted pause, delayed work or idle reachability. Worker processes are created only when a claim executes and retain the existing owned-group lifecycle.

Shutdown stops claims, aborts and awaits workers, closes clients and only then releases database/kernel ownership. SIGKILL relies on the existing process-parent-loss and fenced reconciliation rules. A systemd user unit provides bounded restart, journal logs and control-group cleanup. Installing/enabling the unit, changing lingering and changing machine suspend policy remain owner operations. Service restart is testable without logging out or changing global machine settings.
