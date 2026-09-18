# pi-herdr-blocker

Pi extension that reports "blocked" state to [herdr](https://github.com/lukilev/herdr), plus an `ask_me` tool the agent can call to block on purpose.

## Install

```bash
pi install npm:@po.dev/pi-herdr-blocker
```

Or load locally:

```bash
pi -e ./pi-herdr-blocker/index.ts
```

## Features

- Bridges Pi 0.84.4+ `ui_prompt_start` / `ui_prompt_end` → `herdr:blocked` event
- `ask_me` tool — the agent asks you a question and the turn blocks until you answer
- Tool call and result are rendered blank; the overlay already shows both

## How blocking works

Only these calls fire `ui_prompt_start`:

```
ctx.ui.select()  ctx.ui.confirm()  ctx.ui.input()  ctx.ui.editor()  ctx.ui.custom()
```

A plain-text agent reply does **not** block — the turn has already ended, so Pi emits no signal. "Blocked" means the code is actually parked on an `await`, not that a human hasn't replied yet.

## ask_me

```
question   string    the question to ask
options    string[]  optional choices (renders a select instead of an input)
```

`executionMode: "sequential"` so the model can't batch `ask_me` with `bash`/`write` and have those run before you see the prompt.

## Requirements

- Pi >= 0.84.4 (for the `ui_prompt_*` events)
- herdr, if you want the blocked state displayed anywhere
