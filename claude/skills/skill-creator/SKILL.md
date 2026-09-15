---
name: skill-creator
description: Create or improve a reusable agent skill when the user asks to add, rewrite, shorten, evaluate, package, or tune a SKILL.md. Define a clear trigger and contract, keep the normal workflow portable, and use advanced evaluation only when it is requested or materially useful.
---

# Skill creator

Turn a repeatable workflow into a compact, harness-portable skill. Prefer one useful procedure
over a general manual about agents.

## Establish the contract

Use the conversation and existing repository conventions first. Ask only for a missing decision
that materially changes the skill. Establish its trigger boundary, inputs, outputs, completion
condition, safety boundary, and capabilities that are required, optional, or unavailable.

## Author

Create `SKILL.md` with YAML `name` and `description`, followed by a short imperative workflow.

1. Put trigger language in the description; include near misses only where they prevent a real
   false trigger.
2. Put the normal path first. Move history, provider-specific recipes, long examples, and rare
   branches into references with an explicit loading condition.
3. Prefer capability checks such as “use an available browser tool” over a harness, model, home
   path, CLI, account, or background server.
4. State only boundaries owned by the skill. Inherit the workbench's approval, secrecy, process,
   test-isolation, and verification rules instead of copying them.
5. Bundle deterministic repeated work in an existing script only when it has a defined input,
   output, and failure behavior. Do not invent dependencies merely to make a skill look complete.
6. Keep the active body concise. Preserve a detailed existing procedure as a conditional reference
   instead of deleting protections or domain knowledge.

## Verify proportionately

A simple text-only edit needs no separate evaluation round: read the changed contract and retain
relevant existing evidence. Add a focused check only for a concrete risk, such as a changed script
or tool contract, a missing proof, a requested evaluation, or a publish boundary. Reuse a passing
relevant check; do not repeat it through author, worker, and reviewer by default. Follow
`~/.claude/regeln/verifikation.md` where it applies.

## Advanced work, only when needed

For an explicitly requested benchmark, blind comparison, description experiment, packaging, or
human review workflow, read `references/advanced-workflow-2026-09-12.md`. It preserves the former
full procedure. Treat every path named there as relative to this skill root, not to the reference
file; verify current capability before using it. Provider-specific commands, including `claude -p`,
are examples for their own provider, never commands to translate or substitute automatically.

## Deliver

Report the skill path, trigger boundary, resources, and evidence actually used. Name unavailable
capabilities plainly and leave the normal authoring path usable without them.
