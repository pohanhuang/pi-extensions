/**
 * /models — Model & Context Window Settings
 *
 * Tab 1 (Overview): current provider, model, context window usage
 * Tab 2 (Settings): pick default provider + model, set context window cap
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, matchesKey, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// =============================================================================
// Types & Data Loading
// =============================================================================

interface ModelEntry {
	id: string;
	name?: string;
	provider: string;
	contextWindow: number;
}

interface PiSettings {
	defaultProvider?: string;
	defaultModel?: string;
	[key: string]: unknown;
}

function agentDir(): string {
	return join(homedir(), ".pi", "agent");
}

function loadModels(): { providers: string[]; byProvider: Map<string, ModelEntry[]> } {
	try {
		const raw: Record<string, { models: ModelEntry[] }> = JSON.parse(
			readFileSync(join(agentDir(), "models-store.json"), "utf8")
		);
		const byProvider = new Map<string, ModelEntry[]>();
		for (const [provider, info] of Object.entries(raw)) {
			byProvider.set(provider, info.models ?? []);
		}
		return { providers: Array.from(byProvider.keys()), byProvider };
	} catch {
		return { providers: [], byProvider: new Map() };
	}
}

function loadSettings(): PiSettings {
	try {
		return JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"));
	} catch {
		return {};
	}
}

function saveSettings(settings: PiSettings): void {
	writeFileSync(join(agentDir(), "settings.json"), JSON.stringify(settings, null, 2) + "\n");
}

function fmtCtx(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1000)}K`;
	return String(n);
}

function padRight(s: string, n: number): string {
	const w = visibleWidth(s);
	return w >= n ? s : s + " ".repeat(n - w);
}

// =============================================================================
// Component
// =============================================================================

type Tab = "overview" | "settings";

// Cursor positions in settings tab
const S_PROVIDER = 0;
const S_MODEL = 1;
const S_CTX = 2;
const S_APPLY = 3;

class ModelSettingsComponent {
	private tab: Tab = "overview";
	private theme: Theme;
	private requestRender: () => void;
	private done: () => void;
	private ctx: ExtensionCommandContext;

	// Model data
	private providers: string[];
	private byProvider: Map<string, ModelEntry[]>;

	// Settings state
	private settings: PiSettings;
	private providerIdx: number;
	private modelIdx: number;

	// Context window editing
	private ctxInput = "";
	private editingCtx = false;

	// UI state
	private cursor = S_PROVIDER;
	private savedNote: string | null = null;

	constructor(theme: Theme, ctx: ExtensionCommandContext, requestRender: () => void, done: () => void) {
		this.theme = theme;
		this.ctx = ctx;
		this.requestRender = requestRender;
		this.done = done;

		const { providers, byProvider } = loadModels();
		this.providers = providers;
		this.byProvider = byProvider;
		this.settings = loadSettings();

		const curProvider = this.settings.defaultProvider ?? providers[0] ?? "";
		this.providerIdx = Math.max(0, providers.indexOf(curProvider));

		const curModel = this.settings.defaultModel ?? "";
		const models = this.modelsForProvider(this.providerIdx);
		const mIdx = models.findIndex((m) => m.id === curModel);
		this.modelIdx = Math.max(0, mIdx);
	}

	private modelsForProvider(providerIdx: number): ModelEntry[] {
		const p = this.providers[providerIdx];
		return p ? (this.byProvider.get(p) ?? []) : [];
	}

	private selectedModel(): ModelEntry | null {
		return this.modelsForProvider(this.providerIdx)[this.modelIdx] ?? null;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			if (this.editingCtx) {
				this.editingCtx = false;
				this.requestRender();
				return;
			}
			this.done();
			return;
		}

		if (matchesKey(data, "tab")) {
			this.tab = this.tab === "overview" ? "settings" : "overview";
			this.editingCtx = false;
			this.requestRender();
			return;
		}

		if (this.tab === "settings") this.handleSettingsInput(data);
	}

	private handleSettingsInput(data: string): void {
		if (this.editingCtx) {
			if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
				this.editingCtx = false;
			} else if (matchesKey(data, "backspace")) {
				this.ctxInput = this.ctxInput.slice(0, -1);
			} else if (/^\d$/.test(data) && this.ctxInput.length < 3) {
				const next = this.ctxInput + data;
				if (parseInt(next) < 1000) this.ctxInput = next;
			}
			this.requestRender();
			return;
		}

		if (matchesKey(data, "up")) {
			this.cursor = Math.max(0, this.cursor - 1);
		} else if (matchesKey(data, "down")) {
			this.cursor = Math.min(S_APPLY, this.cursor + 1);
		} else if (matchesKey(data, "left") || matchesKey(data, "right")) {
			const step = matchesKey(data, "left") ? -1 : 1;
			if (this.cursor === S_PROVIDER && this.providers.length > 0) {
				this.providerIdx = (this.providerIdx + step + this.providers.length) % this.providers.length;
				this.modelIdx = 0;
				this.savedNote = null;
			} else if (this.cursor === S_MODEL) {
				const models = this.modelsForProvider(this.providerIdx);
				if (models.length > 0) {
					this.modelIdx = (this.modelIdx + step + models.length) % models.length;
					this.savedNote = null;
				}
			}
		} else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
			if (this.cursor === S_CTX) {
				this.editingCtx = true;
			} else if (this.cursor === S_APPLY) {
				this.applySettings();
			}
		}

		this.requestRender();
	}

	private applySettings(): void {
		const provider = this.providers[this.providerIdx];
		const model = this.selectedModel();
		if (!provider || !model) return;

		this.settings.defaultProvider = provider;
		this.settings.defaultModel = model.id;

		if (this.ctxInput) {
			(this.settings as any).contextWindow = parseInt(this.ctxInput) * 1000;
		} else {
			delete (this.settings as any).contextWindow;
		}

		saveSettings(this.settings);
		this.savedNote = "Saved — takes effect on next pi session";
	}

	render(width: number): string[] {
		const th = this.theme;
		const tabs = (["overview", "settings"] as Tab[])
			.map((t) => (t === this.tab ? th.fg("accent", `[${t}]`) : th.fg("dim", ` ${t} `)))
			.join(" ");

		return [tabs, "", ...(this.tab === "overview" ? this.renderOverview(width) : this.renderSettings(width))];
	}

	private renderOverview(width: number): string[] {
		const th = this.theme;
		const model = this.ctx.model;
		const ctxUsage = this.ctx.getContextUsage();
		const lines: string[] = [];

		lines.push(th.bold("Current Model"));
		lines.push("");
		lines.push(`  Provider     ${th.fg("accent", model?.provider ?? "—")}`);
		lines.push(`  Model        ${th.fg("accent", model?.id ?? "—")}`);
		lines.push(`  Reasoning    ${model?.reasoning ? th.fg("success", "yes") : th.fg("dim", "no")}`);
		lines.push("");

		lines.push(th.bold("Context Window"));
		lines.push("");

		if (ctxUsage) {
			const used = ctxUsage.tokens ?? 0;
			const total = ctxUsage.contextWindow ?? 0;
			const pct = ctxUsage.percent?.toFixed(1) ?? "?";
			const left = Math.max(0, total - used);

			lines.push(`  Window       ${th.fg("accent", fmtCtx(total))}`);
			lines.push(`  Used         ${th.fg("warning", fmtCtx(used))}  (${pct}%)`);
			lines.push(`  Remaining    ${th.fg("success", fmtCtx(left))}`);
			lines.push("");

			const barW = Math.max(10, Math.min(40, width - 16));
			const filled = total > 0 ? Math.round((used / total) * barW) : 0;
			const bar = th.fg("warning", "█".repeat(filled)) + th.fg("dim", "░".repeat(barW - filled));
			lines.push(`  ${bar}  ${pct}%`);
		} else {
			lines.push(th.fg("dim", "  No context data available."));
		}

		lines.push("");
		lines.push(th.fg("dim", "[Tab] settings  [q] close"));
		return lines;
	}

	private renderSettings(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		const provider = this.providers[this.providerIdx] ?? "—";
		const models = this.modelsForProvider(this.providerIdx);
		const model = models[this.modelIdx];
		const modelCount = models.length;

		const row = (idx: number, label: string, value: string, hint: string) => {
			const sel = idx === this.cursor;
			const marker = sel ? th.fg("accent", "▸ ") : "  ";
			const lbl = padRight(sel ? th.fg("accent", label) : th.fg("muted", label), 16);
			const val = sel ? th.fg("accent", value) : value;
			const h = hint ? "  " + th.fg("dim", hint) : "";
			return `${marker}${lbl}${val}${h}`;
		};

		lines.push(th.bold("Default Model Settings"));
		lines.push(th.fg("dim", "Takes effect on next pi session"));
		lines.push("");

		const providerHint = `${this.providerIdx + 1}/${this.providers.length}  [←→]`;
		lines.push(row(S_PROVIDER, "Provider", provider, providerHint));
		lines.push("");

		const modelName = model ? truncateToWidth(model.id, Math.max(20, width - 40)) : "—";
		const modelHint = `${this.modelIdx + 1}/${modelCount}  [←→]`;
		lines.push(row(S_MODEL, "Model", modelName, modelHint));

		if (model) {
			lines.push(th.fg("dim", `                   ctx: ${fmtCtx(model.contextWindow)}`));
		}
		lines.push("");

		const ctxDisplay = this.editingCtx
			? th.fg("accent", `${this.ctxInput || "0"}K▌`)
			: this.ctxInput
			? `${this.ctxInput}K`
			: th.fg("dim", "model default");
		const ctxHint = this.editingCtx ? "[0-9] type · [Enter] done" : "[Enter] edit · max 999K";
		lines.push(row(S_CTX, "Context Window", ctxDisplay, ctxHint));
		lines.push("");

		// Apply button
		const applyLabel = "[ Apply to all ]";
		lines.push(
			this.cursor === S_APPLY
				? `  ${th.fg("accent", applyLabel)}`
				: `  ${th.fg("dim", applyLabel)}`
		);

		if (this.savedNote) {
			lines.push("");
			lines.push(th.fg("success", `  ✓ ${this.savedNote}`));
		}

		lines.push("");
		lines.push(th.fg("dim", "[↑↓] navigate · [←→] change · [Enter] edit/apply · [Tab] overview · [q] close"));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerCommand("models", {
		description: "View current model info and configure default model settings",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const border = new Container();
				border.addChild(new Spacer(1));
				border.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
				border.addChild(new Spacer(1));

				const comp = new ModelSettingsComponent(theme, ctx, () => tui.requestRender(), done);

				return {
					render: (w: number) => [
						...border.render(w),
						...comp.render(w),
						"",
						theme.fg("border", "─".repeat(w)),
					],
					invalidate: () => border.invalidate(),
					handleInput: (input: string) => comp.handleInput(input),
					dispose: () => {},
				};
			});
		},
	});
}
