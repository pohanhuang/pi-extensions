# @po.dev/pi-branch-workspace

Pi extension that creates a per-git-branch workspace under `.pi/<branch>/` and injects the small branch context into the system prompt.

Install:

```bash
pi install npm:@po.dev/pi-branch-workspace
```

Local test:

```bash
pi -e ./branch-workspace/index.ts
```

Mode:

```bash
/mode                 # choose interactively
/mode plan
/mode discuss
/mode implement
```

Rules:
- Missing `.mode` becomes `plan`
- Existing valid `.mode` is preserved
- Invalid `.mode` resets to `plan`
- `discuss.md` is not loaded unless explicitly read
