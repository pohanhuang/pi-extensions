# usage-dashboard

Pi extension for token and cost tracking.

## Install

```bash
pi install npm:@po.dev/pi-usage-dashboard
```

Or load locally:

```bash
pi -e ./usage-dashboard/index.ts
```

## Features

- Footer shows live session cost — survives `/reload` without resetting
- `/usage` opens a full dashboard: daily spend, per-model breakdown, cache efficiency

## Usage

```
/usage      open dashboard
/reload     session cost persists (no reset)
```
