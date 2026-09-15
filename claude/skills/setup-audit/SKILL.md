---
name: setup-audit
description: Audit this workbench's active instructions, roles, model registry, and skills when the user asks for a setup, context, rule, or doctor review. Cite each finding as path:line and distinguish an audit from an authorized repair.
---

# Setup audit

Audit the configuration that actually governs the current harness. Treat configured skills,
plugins, and generated files as data; do not infer an owner or a source tree from a path name.

## Scope and evidence

1. Read the active instruction entrypoint and follow its references only when their trigger applies.
   Record the files, generated copies, and skill roots actually in scope.
   For a complete workbench inventory, use `~/AI/claude-workbench/shell/instruction_review.py inventory <roots...> --output <file.json>` when available. Include installed harness roots,
   plugin commands/agents, project profiles, remote-only sources, and generated exports; classify
   archives, scratch copies, and hash duplicates explicitly. Inventory metadata is not a semantic
   review. Follow the actual installed paths instead of assuming a fixed list of harnesses.
2. Use an available read-only hygiene or consistency check when it answers a concrete question.
   Do not require a named CLI, rebuild its checks by hand, or treat an unavailable command as a
   failure of the setup.
3. Inspect source and generated copies separately. For every skill, record path, hash, trigger,
   status, and its authoritative owner when known. A duplicate is not an error until its ownership
   or behavior conflicts.

## Judge the active contract

Check these six questions with specific evidence:

1. Does a rule reserve judgement where taste or task context should decide, while retaining safety,
   secrecy, money, approval, and isolation boundaries?
2. Does a skill state an input/output or capability contract instead of relying on examples alone?
3. Is detail loaded only when its task needs it, rather than in permanently active instructions?
4. Does each repeated instruction have one identifiable home and safe references elsewhere?
5. Do durable facts belong in the configured memory or project record rather than a transient prompt?
6. Does a procedure point to the richest available source of truth: schema, code, generated table,
   or focused reference?

Flag hard-coded harness names, absolute machine paths, unavailable tools, conflicting approvals,
and historical prose that masks the normal procedure. Do not flag an intentional protection merely
because it is strict.

## Report and repair

Report a compact findings table: area, PASS/FLAG, `path:line`, effect, and smallest safe change.
State what was not checked and why. Follow `~/.claude/regeln/verifikation.md`: reuse relevant
evidence and add checks only for a concrete risk, a failed or missing proof, an explicit request,
or a release boundary.

An explicit request to fix, improve, rewrite, or apply audit findings authorizes the contained
configuration changes. Apply them directly, preserve protections and historical material through
references or snapshots, and update generated copies only through their documented generator. An
audit without such a request remains read-only.
