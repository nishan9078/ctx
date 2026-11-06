# Working on CTX

- Treat `CTX_Autonomous_Orchestration_Master_Roadmap.md` as the product specification. Read the selected phase, its dependencies and exit gate, plus the actual code before editing.
- Work one phase or bounded subtask at a time on a new branch. State the plan, expected files and verification. Reuse working modules and preserve human changes and evidence.
- Consult `CURRENT_STATE.md` and `docs/decisions/ADR-000-baseline.md` for the baseline and runtime split. Update decisions when adapter versions, schema or policy change.
- For scheduler/persistence changes, use deterministic fake workers and failure injection. Never remove, weaken or skip failing checks to get a pass. Distinguish product defects from environment limitations.
- Run relevant typecheck, build, unit and integration checks. Record exact commands, exit codes and evidence. Label fake, mocked, live and unavailable coverage separately.
- Preserve immutable verification requirements and approval boundaries. No production credentials, deployments, payments or destructive operations without explicit authorization. Investigate unexpected environment failures; do not change global settings or bypass sandbox restrictions.
- Stop and report structural uncertainty such as conflicting migrations or corruption. Honor release gates; implementation alone does not prove readiness.
- Finish each phase with a short report covering changes, checks, acceptance evidence, limitations, gate status and next dependencies. Use the roadmap section 22 report format.
- Commit each completed feature after verification. Stage only the intended implementation, tests and evidence; preserve unrelated user files.
