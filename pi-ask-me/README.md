# pi-ask-me

Pi extension that lets the agent ask you a question and **block the turn** until you answer. Also reports that blocked state to [herdr](https://github.com/lukilev/herdr).

## Install

```bash
pi install npm:@po.dev/pi-ask-me
```

Or load locally:

```bash
pi -e ./pi-ask-me/index.ts
```

## Features

- `ask_me` tool — the agent asks, the turn parks on an `await` until you answer
- Bridges Pi 0.84.4+ `ui_prompt_start` / `ui_prompt_end` → `herdr:blocked` event
- Tool call and result render blank; the overlay already shows both

## ask_me

```
question   string    the question to ask
options    string[]  optional choices (renders a select instead of an input)
```

`executionMode: "sequential"` so the model can't batch `ask_me` with `bash`/`write` and have those side effects run before you see the prompt.

## How blocking works

Only these calls fire `ui_prompt_start`:

```
ctx.ui.select()  ctx.ui.confirm()  ctx.ui.input()  ctx.ui.editor()  ctx.ui.custom()
```

A plain-text agent reply does **not** block — the turn has already ended, so Pi emits no signal. "Blocked" means the code is actually parked, not that a human hasn't replied yet.

## Requirements

- Pi >= 0.84.4 (for the `ui_prompt_*` events)
- herdr, only if you want the blocked state displayed somewhere
