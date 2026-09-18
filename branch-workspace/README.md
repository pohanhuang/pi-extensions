# branch-workspace

Pi extension that gives each git branch its own workspace and a discuss / implement mode guard.

## Install

```bash
pi install npm:@po.dev/pi-branch-workspace
```

Or load locally:

```bash
pi -e ./branch-workspace/index.ts
```

## Features

- Each git branch gets `.pi/<branch>/workspace.md` injected as context every session
- **discuss mode** — blocks all file writes and mutating bash (planning only)
- **implement mode** — full access; auto-commits written files after each agent turn with a changelog entry
- `AGENTS.md` (or `.pi/agents.md`) injected as shared repo instructions

## Commands

```
/mode                  show current mode
/mode discuss          switch to discuss (read-only)
/mode implement        switch to implement (auto-commit on)
/ws                    pick a workspace section to update from conversation
/ws plan               update the Plan section
/ws <section>          update or create any section
/ws commit             commit all uncommitted changes as "wip: <agent summary>"
```

## Workspace layout

```
.pi/
  agents.md                   shared repo instructions
  <branch>/
    workspace.md              plan, discussion, progress notes
    changes.md                auto-generated commit log
    .mode                     current mode (discuss | implement)
```

## Mode rules

- Every session start / `/reload` resets `.mode` to `discuss` — `/mode implement` only lasts the current session
- Missing `.mode` → defaults to `discuss`
- Invalid value → resets to `discuss` with a warning
- Only `/mode` can change `.mode` — direct file writes are blocked
