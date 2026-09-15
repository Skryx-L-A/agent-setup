---
name: session-end
description: Close a work session when the user signals completion or asks to wrap up. Preserve durable knowledge, clean up resources started by the session, and report the exact project and open-work state.
---

# Session end

Close the work without losing decisions, evidence, or recoverable state. Use the session's actual
role and project conventions; do not manufacture filing, checks, or commits for work that did not
occur.

## Collect and preserve

1. Capture substantive decisions, completed work and evidence, open points, recoverable failures,
   and durable files. An orchestrator reads relevant worker result files; a worker puts its own
   findings in its result file for the orchestrator.
2. Persist only material knowledge in the authorized project documentation, memory, rule, or vault
   location. Use the existing convention and preserve prior instructions when reorganizing them.
3. Record any changed project repository state accurately. Commit or push only under the applicable
   repository and authority rules.

## End owned work

Stop temporary processes, workers, downloads, models, and test resources started by this session
when they are no longer needed. Check their end when the resource could affect shared capacity or
another session; never touch user or shared processes. Keep an unfinished task, failed cleanup, or
required human action as an open point.

## Verify and report

Reuse relevant checks already completed for the same state. Do not start a new hygiene run,
testsuite, or independent review merely because the session ends; follow
`~/.claude/regeln/verifikation.md` for a concrete reason to check. Report what changed, what was
persisted, validation actually performed, repository state, open risks, and recovery steps.

For the previous full workbench-specific checklist, including historical paths and role detail, read
`references/historical-workflow-2026-09-12.md` only when a listed operation is genuinely needed.
Paths in that reference resolve from this skill root or the named workbench root, not from the
reference directory.
