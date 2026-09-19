# pi-model-settings

View your current model info and configure default model settings.

## Command

```
/models
```

## Tabs

### Overview
- Current provider & model
- Context window: total / used / remaining with a visual bar

### Settings
- **Provider** — pick from available providers (←→)
- **Model** — pick model for that provider (←→), shows context window size
- **Context Window** — override max context in K (< 1000K), leave empty for model default
- **Apply to all** — saves `defaultProvider`, `defaultModel`, and optional `contextWindow` to `~/.pi/agent/settings.json`

Changes take effect on next pi session start.

## Keys

| Key | Action |
|-----|--------|
| Tab | Switch Overview ↔ Settings |
| ↑↓ | Navigate settings items |
| ←→ | Change provider / model |
| Enter | Edit context window / Apply |
| q / Esc | Close |
