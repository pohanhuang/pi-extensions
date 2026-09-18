/**
 * /usage - Usage statistics dashboard
 *
 * Shows an inline view with usage stats grouped by provider.
 * - Tab cycles: Today → This Week → Last Week → All Time
 * - Arrow keys navigate providers
 * - Enter expands/collapses to show models
 *
 * Data collection and caching live in ./data.ts.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, Container, Spacer, matchesKey, visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import { AUXILIARY_PROVIDER, collectUsageData, getAgentDir, splitHourlyKey, TAB_ORDER } from "./data";
import type { CollectProgress } from "./data";
import type { BaseStats, ProviderStats, TabName, TotalStats, UsageData } from "./data";
import {
	buildGraphModel,
	renderChart,
	GROUP_LABELS,
	GROUP_ORDER,
	METRIC_LABELS,
	METRIC_ORDER,
	TOTAL_SERIES_KEY,
} from "./graph";
import type { GraphGroupBy, GraphMetric, GraphModel } from "./graph";
import {
	buildGraphCsv,
	buildInsightsJson,
	buildTableCsv,
	exportFileName,
	parseExportDirSetting,
	resolveExportDir,
} from "./export";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// =============================================================================
// Footer Settings
// =============================================================================

interface FooterSettings {
	showSession: boolean;
	showToday: boolean;
	showContext: boolean;
}

const DEFAULT_FOOTER_SETTINGS: FooterSettings = {
	showSession: true,
	showToday: false,
	showContext: true,
};

const FOOTER_SETTING_ITEMS: { key: keyof FooterSettings; label: string; description: string }[] = [
	{ key: "showSession", label: "Show session usage", description: "Cost & tokens for the current session" },
	{ key: "showToday", label: "Show today's usage", description: "Cost & tokens aggregated for today" },
	{ key: "showContext", label: "Show context %", description: "Context window usage percentage" },
];

function footerSettingsPath(): string {
	return join(getAgentDir(), "token-dashboard", "footer-settings.json");
}

function loadFooterSettings(): FooterSettings {
	try {
		const raw: unknown = JSON.parse(readFileSync(footerSettingsPath(), "utf8"));
		return typeof raw === "object" && raw !== null ? { ...DEFAULT_FOOTER_SETTINGS, ...(raw as Partial<FooterSettings>) } : { ...DEFAULT_FOOTER_SETTINGS };
	} catch { return { ...DEFAULT_FOOTER_SETTINGS }; }
}

function saveFooterSettings(settings: FooterSettings): void {
	mkdirSync(join(getAgentDir(), "token-dashboard"), { recursive: true });
	writeFileSync(footerSettingsPath(), JSON.stringify(settings, null, 2));
}

type ViewMode = "table" | "insights" | "history" | "graph" | "settings";

const VIEW_CYCLE: ViewMode[] = ["graph", "table", "insights", "history", "settings"]; 

const VIEW_LABELS: Record<ViewMode, string> = {
	graph: "Overview",
	table: "Usage",
	insights: "Insights",
	history: "History",
	settings: "Settings",
};

type PromptItem = { label: string; chars: number; text?: string };
type PromptSection = PromptItem & { children: PromptItem[] };

// Pi stores the assembled prompt only for the running session.  Count its actual
// source spans (not guessed model-usage tokens) so percentages remain useful
// across providers.
function snapshotPath(id: string): string {
	return join(getAgentDir(), "token-dashboard", "prompt-snapshots", `${id}.json`);
}

function savePromptSnapshot(id: string, prompt: string): void {
	if (!id || !prompt) return;
	const path = snapshotPath(id);
	mkdirSync(join(getAgentDir(), "token-dashboard", "prompt-snapshots"), { recursive: true });
	writeFileSync(path, JSON.stringify({ prompt }), "utf8");
}

function loadPromptSnapshot(id: string): string | null {
	try {
		const value: unknown = JSON.parse(readFileSync(snapshotPath(id), "utf8"));
		return typeof value === "object" && value !== null && typeof (value as { prompt?: unknown }).prompt === "string" ? (value as { prompt: string }).prompt : null;
	} catch { return null; }
}

function topChildren(children: PromptItem[], max = 8): PromptItem[] {
	if (children.length <= max) return children;
	return [...children.slice(0, max - 1), { label: "Other", chars: children.slice(max - 1).reduce((sum, child) => sum + child.chars, 0), text: children.slice(max - 1).map((child) => child.text).filter(Boolean).join("\n") }];
}

function promptSections(prompt: string): PromptSection[] {
	const skillsStart = prompt.indexOf("The following skills provide specialized instructions");
	const skillsEnd = prompt.indexOf("</available_skills>");
	const contextStart = prompt.indexOf("# Project Context");
	const metadataStart = Math.max(prompt.lastIndexOf("\nCurrent date:"), prompt.lastIndexOf("\nCurrent date and time:"));
	const boundary = [contextStart, skillsStart, metadataStart].filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? prompt.length;
	const base = prompt.slice(0, boundary);
	const splitBase = (label: string, start: number, end: number): PromptSection | null => end > start ? { label, chars: end - start, text: base.slice(start, end), children: [] } : null;
	const guidelines = base.indexOf("\nGuidelines:");
	const piDocs = base.indexOf("\nPi documentation");
	const baseParts = guidelines >= 0
		? [
			splitBase("System", 0, guidelines),
			splitBase("AGENTS.md / rules", guidelines + 1, piDocs >= 0 ? piDocs : base.length),
			splitBase("Pi docs hints", piDocs >= 0 ? piDocs + 1 : base.length, base.length),
		].filter((p): p is PromptSection => p !== null)
		: [splitBase("System", 0, base.length)].filter((p): p is PromptSection => p !== null);
	const sections: PromptSection[] = [...baseParts];
	if (contextStart >= 0) {
		const end = [skillsStart, metadataStart, prompt.length].filter((n) => n > contextStart).sort((a, b) => a - b)[0]!;
		const text = prompt.slice(contextStart, end);
		const matches = [...text.matchAll(/^## (.+)$/gm)];
		sections.push({ label: "Context files", chars: text.length, text, children: topChildren(matches.map((m, i) => {
			const start = m.index!, end = matches[i + 1]?.index ?? text.length;
			return { label: m[1]!, chars: end - start, text: text.slice(start, end) };
		})) });
	}
	if (skillsStart >= 0) {
		const end = skillsEnd >= 0 ? skillsEnd + "</available_skills>".length : (metadataStart >= 0 ? metadataStart : prompt.length);
		const text = prompt.slice(skillsStart, end);
		const children = [...text.matchAll(/<skill>([\s\S]*?)<\/skill>/g)].map((m) => ({ label: m[1]!.match(/<name>([\s\S]*?)<\/name>/)?.[1]?.trim() ?? "skill", chars: m[0].length, text: m[0] }));
		sections.push({ label: "Skills", chars: text.length, text, children: topChildren(children) });
	}
	if (metadataStart >= 0) sections.push({ label: "Metadata", chars: prompt.length - metadataStart, text: prompt.slice(metadataStart), children: [] });
	return sections.filter((section) => section.chars > 0);
}

// =============================================================================
// Column Configuration
// =============================================================================

interface DataColumn {
	label: string;
	width: number;
	dimmed?: boolean;
	getValue: (stats: BaseStats & { sessions: Set<string> | number }) => string;
}

interface TableLayoutCandidate {
	columns: DataColumn[];
	minNameWidth: number;
	compact?: boolean;
}

interface TableLayout {
	columns: DataColumn[];
	nameWidth: number;
	tableWidth: number;
	compact: boolean;
}

const MAX_NAME_COL_WIDTH = 26;

const SESSIONS_COLUMN: DataColumn = {
	label: "Sessions",
	width: 9,
	getValue: (s) => formatNumber(typeof s.sessions === "number" ? s.sessions : s.sessions.size),
};

const MSGS_COLUMN: DataColumn = {
	label: "Msgs",
	width: 9,
	getValue: (s) => formatNumber(s.messages),
};

const COST_COLUMN: DataColumn = {
	label: "Cost",
	width: 9,
	getValue: (s) => formatCost(s.cost),
};

const TOKENS_COLUMN: DataColumn = {
	label: "Tokens",
	width: 9,
	getValue: (s) => formatTokens(s.tokens.total),
};

const INPUT_COLUMN: DataColumn = {
	label: "↑In",
	width: 8,
	dimmed: true,
	// Include cacheWrite so this reflects fresh input tokens sent this turn,
	// even for providers like Anthropic that split cached prompt creation out
	// from the regular input token count.
	getValue: (s) => formatTokens(s.tokens.input + s.tokens.cacheWrite),
};

const OUTPUT_COLUMN: DataColumn = {
	label: "↓Out",
	width: 8,
	dimmed: true,
	getValue: (s) => formatTokens(s.tokens.output),
};

const CACHE_COLUMN: DataColumn = {
	label: "Cache",
	width: 8,
	dimmed: true,
	getValue: (s) => formatTokens(s.tokens.cacheRead + s.tokens.cacheWrite),
};

const FULL_DATA_COLUMNS: DataColumn[] = [
	SESSIONS_COLUMN,
	MSGS_COLUMN,
	COST_COLUMN,
	TOKENS_COLUMN,
	INPUT_COLUMN,
	OUTPUT_COLUMN,
	CACHE_COLUMN,
];

const TABLE_LAYOUTS: TableLayoutCandidate[] = [
	{ columns: FULL_DATA_COLUMNS, minNameWidth: MAX_NAME_COL_WIDTH },
	{ columns: [SESSIONS_COLUMN, MSGS_COLUMN, COST_COLUMN, TOKENS_COLUMN], minNameWidth: 14, compact: true },
	{ columns: [SESSIONS_COLUMN, COST_COLUMN, TOKENS_COLUMN], minNameWidth: 12, compact: true },
	{ columns: [COST_COLUMN, TOKENS_COLUMN], minNameWidth: 10, compact: true },
	{ columns: [COST_COLUMN], minNameWidth: 8, compact: true },
];

// =============================================================================
// Formatting Helpers
// =============================================================================

function formatCost(cost: number): string {
	if (cost === 0) return "-";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(2)}`;
	if (cost < 10) return `$${cost.toFixed(2)}`;
	if (cost < 100) return `$${cost.toFixed(1)}`;
	return `$${Math.round(cost)}`;
}

function formatTokens(count: number): string {
	if (count === 0) return "-";
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatNumber(n: number): string {
	if (n === 0) return "-";
	return n.toLocaleString();
}

// Compact axis/legend formatters for the graph view.
function formatAxisCost(v: number): string {
	if (v === 0) return "$0";
	if (v < 1) return `$${v.toFixed(2)}`;
	if (v < 100) return `$${v.toFixed(1)}`;
	if (v < 10_000) return `$${Math.round(v)}`;
	if (v < 1_000_000) return `$${(v / 1000).toFixed(1)}k`;
	return `$${(v / 1_000_000).toFixed(2)}M`;
}

function formatAxisCount(v: number): string {
	if (v === 0) return "0";
	if (v < 1000) return String(Math.round(v));
	if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
	if (v < 1_000_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
	return `${(v / 1_000_000_000).toFixed(1)}B`;
}

// Bright ANSI palette for graph series (Total uses index 0).
const SERIES_COLORS = ["\x1b[97m", "\x1b[96m", "\x1b[95m", "\x1b[93m", "\x1b[92m", "\x1b[94m", "\x1b[91m", "\x1b[90m"];
const COLOR_RESET = "\x1b[39m";

function seriesColor(index: number): string {
	return SERIES_COLORS[index % SERIES_COLORS.length]!;
}

/** "14:32" if the timestamp is today, otherwise "16 Jul" (with year if not this year). */
function formatSinceDate(ms: number): string {
	const d = new Date(ms);
	const now = new Date();
	if (d.toDateString() === now.toDateString()) {
		return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	}
	const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
	if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
	return d.toLocaleDateString(undefined, opts);
}

function padLeft(s: string, len: number): string {
	const vis = visibleWidth(s);
	if (vis >= len) return s;
	return " ".repeat(len - vis) + s;
}

function padRight(s: string, len: number): string {
	const vis = visibleWidth(s);
	if (vis >= len) return s;
	return s + " ".repeat(len - vis);
}

function sumColumnWidths(columns: DataColumn[]): number {
	return columns.reduce((sum, col) => sum + col.width, 0);
}

function fitCell(s: string, len: number, align: "left" | "right" = "left"): string {
	if (len <= 0) return "";
	const truncated = truncateToWidth(s, len);
	return align === "right" ? padLeft(truncated, len) : padRight(truncated, len);
}

function clampLines(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, Math.max(width, 0)));
}

function pickFittingText(width: number, variants: string[]): string {
	for (const variant of variants) {
		if (visibleWidth(variant) <= width) return variant;
	}
	return variants[variants.length - 1] || "";
}

function previewText(text: string | undefined, width: number, limit = 18): string[] {
	if (!text) return [];
	const raw = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const useful = raw
		.filter((line) => !/^(You are an expert coding assistant|Available tools:|In addition to the tools|The following skills|Use the read tool|When a skill file|<\/?available_skills>|<\/?skill>|<location>|<description>|<\/description>)/.test(line))
		.filter((line) => !/^- (read|bash|edit|write): /.test(line))
		.map((line) => line.replace(/<\/?name>/g, ""))
		.filter(Boolean);
	return (useful.length ? useful : raw)
		.slice(0, limit)
		.flatMap((line) => wrapTextWithAnsi(line, Math.max(20, width - 4)).slice(0, 2));
}

function getTableLayout(width: number): TableLayout {
	const safeWidth = Math.max(width, 0);

	for (const candidate of TABLE_LAYOUTS) {
		const columnsWidth = sumColumnWidths(candidate.columns);
		const nameWidth = Math.min(MAX_NAME_COL_WIDTH, Math.max(safeWidth - columnsWidth, 0));
		if (nameWidth >= candidate.minNameWidth) {
			return {
				columns: candidate.columns,
				nameWidth,
				tableWidth: nameWidth + columnsWidth,
				compact: candidate.compact ?? false,
			};
		}
	}

	const fallback = TABLE_LAYOUTS[TABLE_LAYOUTS.length - 1]!;
	const fallbackColumnsWidth = sumColumnWidths(fallback.columns);
	const fallbackNameWidth = Math.min(MAX_NAME_COL_WIDTH, Math.max(safeWidth - fallbackColumnsWidth, 0));
	return {
		columns: fallback.columns,
		nameWidth: fallbackNameWidth,
		tableWidth: fallbackNameWidth + fallbackColumnsWidth,
		compact: fallback.compact ?? false,
	};
}

// =============================================================================
// Component
// =============================================================================

const TAB_LABELS: Record<TabName, string> = {
	today: "Today",
	thisWeek: "This Week",
	lastWeek: "Last Week",
	last30Days: "Last 30 Days",
	allTime: "All Time",
};

class UsageComponent {
	private activeTab: TabName = "allTime";
	private viewMode: ViewMode = "graph";
	private data: UsageData;
	private selectedIndex = 0;
	private expanded = new Set<string>();
	private providerOrder: string[] = [];
	private theme: Theme;
	private requestRender: () => void;
	private done: () => void;

	// Graph explorer state.
	private graphMetric: GraphMetric = "cost";
	private graphGroupBy: GraphGroupBy = "provider";
	private graphCumulative = true;
	private exportNote: { text: string; ok: boolean } | null = null;
	private tableHidden = new Set<string>();
	private tableFilter = "";
	private tableFilterEditing = false;
	private graphHidden = new Set<string>();
	private graphLegendIndex = 0;
	private graphDetailProvider: string | null = null;
	private promptSections: PromptSection[];
	private insightIndex = 0;
	private insightDetail: PromptSection | null = null;
	private insightContent: PromptItem | null = null;
	private historyIndex = 0;
	private historySelected: string | null = null;
	private currentSessionId: string;
	private currentPrompt: string;
	private footerSettings: FooterSettings;
	private settingsIndex = 0;
	private onSettingsChange: (settings: FooterSettings) => void;

	constructor(theme: Theme, data: UsageData, prompt: string, currentSessionId: string, requestRender: () => void, done: () => void, footerSettings: FooterSettings, onSettingsChange: (settings: FooterSettings) => void) {
		this.theme = theme;
		this.requestRender = requestRender;
		this.done = done;
		this.data = data;
		this.currentSessionId = currentSessionId;
		this.currentPrompt = prompt;
		this.promptSections = promptSections(prompt);
		this.footerSettings = { ...footerSettings };
		this.onSettingsChange = onSettingsChange;
		this.updateProviderOrder();
	}

	private updateProviderOrder(): void {
		const stats = this.data[this.activeTab];
		this.providerOrder = Array.from(stats.providers.entries())
			.filter(([name]) => name !== AUXILIARY_PROVIDER)
			.sort((a, b) => b[1].cost - a[1].cost)
			.map(([name]) => name);
		this.clampTableSelection();
	}

	private clampTableSelection(): void {
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.visibleTable().providers.size - 1));
	}

	/**
	 * The table slice after hides and the text filter. A filter matches a
	 * provider name (whole provider stays) or individual model names, in which
	 * case the provider row is synthesized from just the matching models so
	 * the totals row and exports reflect exactly what is on screen.
	 */
	private visibleTable(): { providers: Map<string, ProviderStats>; totals: TotalStats } {
		const stats = this.data[this.activeTab];
		const q = this.tableFilter.trim().toLowerCase();
		// Always iterate providerOrder so the map is cost-sorted — selection
		// indexes and rendered rows must agree on ordering.
		const providers = new Map<string, ProviderStats>();
		for (const name of this.providerOrder) {
			if (this.tableHidden.has(name)) continue;
			const full = stats.providers.get(name)!;
			if (!q || name.toLowerCase().includes(q)) {
				providers.set(name, full);
				continue;
			}
			const models = new Map(Array.from(full.models).filter(([model]) => model.toLowerCase().includes(q)));
			if (models.size === 0) continue;
			const synth: ProviderStats = {
				messages: 0,
				cost: 0,
				tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				sessions: new Set<string>(),
				models,
			};
			for (const model of models.values()) {
				synth.messages += model.messages;
				synth.cost += model.cost;
				synth.tokens.total += model.tokens.total;
				synth.tokens.input += model.tokens.input;
				synth.tokens.output += model.tokens.output;
				synth.tokens.cacheRead += model.tokens.cacheRead;
				synth.tokens.cacheWrite += model.tokens.cacheWrite;
				for (const s of model.sessions) synth.sessions.add(s);
			}
			providers.set(name, synth);
		}
		const totals: TotalStats = {
			sessions: 0,
			messages: 0,
			cost: 0,
			tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const sessions = new Set<string>();
		for (const provider of providers.values()) {
			totals.messages += provider.messages;
			totals.cost += provider.cost;
			totals.tokens.total += provider.tokens.total;
			totals.tokens.input += provider.tokens.input;
			totals.tokens.output += provider.tokens.output;
			totals.tokens.cacheRead += provider.tokens.cacheRead;
			totals.tokens.cacheWrite += provider.tokens.cacheWrite;
			for (const s of provider.sessions) sessions.add(s);
		}
		totals.sessions = sessions.size;
		return { providers, totals };
	}

	handleInput(data: string): void {
		// Filter typing captures printable keys, so it runs before everything.
		if (this.viewMode === "table" && this.tableFilterEditing) {
			if (matchesKey(data, "escape")) {
				this.tableFilter = "";
				this.tableFilterEditing = false;
			} else if (matchesKey(data, "enter")) {
				this.tableFilterEditing = false;
			} else if (matchesKey(data, "backspace")) {
				this.tableFilter = this.tableFilter.slice(0, -1);
			} else if (data.length === 1 && data >= " " && data !== "\x7f") {
				this.tableFilter += data;
			}
			this.clampTableSelection();
			this.requestRender();
			return;
		}

		if (matchesKey(data, "escape") && (this.insightContent || this.insightDetail || (this.viewMode === "history" && this.historySelected))) {
			if (this.insightContent) this.insightContent = null;
			else if (this.insightDetail) this.insightDetail = null;
			else this.historySelected = null;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done();
			return;
		}

		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			const step = matchesKey(data, "shift+tab") ? -1 : 1;
			const idx = VIEW_CYCLE.indexOf(this.viewMode);
			this.viewMode = VIEW_CYCLE[(idx + step + VIEW_CYCLE.length) % VIEW_CYCLE.length]!;
			this.exportNote = null;
			this.requestRender();
			return;
		}

		if (matchesKey(data, "e")) {
			this.exportCurrentView();
			this.requestRender();
			return;
		}

		if (this.viewMode === "graph" && this.handleGraphInput(data)) {
			return;
		}
		if (this.viewMode === "insights" && this.handleInsightInput(data)) return;
		if (this.viewMode === "history" && this.handleHistoryInput(data)) return;
		if (this.viewMode === "settings" && this.handleSettingsInput(data)) return;

		if (matchesKey(data, "right")) {
			const idx = TAB_ORDER.indexOf(this.activeTab);
			this.activeTab = TAB_ORDER[(idx + 1) % TAB_ORDER.length]!;
			this.updateProviderOrder();
			this.exportNote = null;
			this.requestRender();
		} else if (matchesKey(data, "left")) {
			const idx = TAB_ORDER.indexOf(this.activeTab);
			this.activeTab = TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length]!;
			this.updateProviderOrder();
			this.exportNote = null;
			this.requestRender();
		} else if (this.viewMode === "graph") {
			// Graph-specific keys were handled above; swallow table-only keys.
		} else if (this.viewMode === "table" && data === "/") {
			this.tableFilterEditing = true;
			this.requestRender();
		} else if (this.viewMode === "table" && data === "x") {
			const visible = Array.from(this.visibleTable().providers.keys());
			const provider = visible[this.selectedIndex];
			if (provider) {
				this.tableHidden.add(provider);
				this.clampTableSelection();
				this.requestRender();
			}
		} else if (this.viewMode === "table" && data === "a") {
			this.tableHidden.clear();
			this.tableFilter = "";
			this.tableFilterEditing = false;
			this.clampTableSelection();
			this.requestRender();
		} else if (this.viewMode === "table" && matchesKey(data, "up")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.requestRender();
			}
		} else if (this.viewMode === "table" && matchesKey(data, "down")) {
			if (this.selectedIndex < this.visibleTable().providers.size - 1) {
				this.selectedIndex++;
				this.requestRender();
			}
		} else if (this.viewMode === "table" && (matchesKey(data, "enter") || matchesKey(data, "space"))) {
			const provider = Array.from(this.visibleTable().providers.keys())[this.selectedIndex];
			if (provider) {
				if (this.expanded.has(provider)) {
					this.expanded.delete(provider);
				} else {
					this.expanded.add(provider);
				}
				this.requestRender();
			}
		}
	}

	// -------------------------------------------------------------------------
	// Render Methods
	// -------------------------------------------------------------------------

	private handleGraphInput(data: string): boolean {
		if (matchesKey(data, "m")) {
			const idx = METRIC_ORDER.indexOf(this.graphMetric);
			this.graphMetric = METRIC_ORDER[(idx + 1) % METRIC_ORDER.length]!;
		} else if (matchesKey(data, "g")) {
			const idx = GROUP_ORDER.indexOf(this.graphGroupBy);
			this.graphGroupBy = GROUP_ORDER[(idx + 1) % GROUP_ORDER.length]!;
			this.graphHidden.clear();
			this.graphLegendIndex = 0;
		} else if (matchesKey(data, "c")) {
			this.graphCumulative = !this.graphCumulative;
		} else if (matchesKey(data, "a")) {
			this.graphHidden.clear();
		} else if (matchesKey(data, "up")) {
			this.graphLegendIndex = Math.max(0, this.graphLegendIndex - 1);
		} else if (matchesKey(data, "down")) {
			const count = this.buildDailyProviderModel().providers.length;
			this.graphLegendIndex = Math.min(Math.max(count - 1, 0), this.graphLegendIndex + 1);
		} else if (matchesKey(data, "enter")) {
			const target = this.buildDailyProviderModel().providers[this.graphLegendIndex];
			if (target) this.graphDetailProvider = this.graphDetailProvider === target.name ? null : target.name;
		} else if (matchesKey(data, "space")) {
			const target = this.buildDailyProviderModel().providers[this.graphLegendIndex];
			if (target) {
				if (this.graphHidden.has(target.name)) this.graphHidden.delete(target.name);
				else this.graphHidden.add(target.name);
			}
		} else {
			return false;
		}
		this.requestRender();
		return true;
	}

	private handleInsightInput(data: string): boolean {
		if (this.insightContent) return false;
		const rows = this.insightDetail ? this.insightDetail.children : this.promptSections;
		if (matchesKey(data, "up")) this.insightIndex = Math.max(0, this.insightIndex - 1);
		else if (matchesKey(data, "down")) this.insightIndex = Math.min(Math.max(rows.length - 1, 0), this.insightIndex + 1);
		else if (matchesKey(data, "enter")) {
			const row = rows[this.insightIndex];
			if (!row) return true;
			if (!this.insightDetail && "children" in row && row.children.length) {
				this.insightDetail = row;
				this.insightIndex = 0;
			} else {
				this.insightContent = row;
			}
		} else return false;
		this.requestRender();
		return true;
	}

	private handleSettingsInput(data: string): boolean {
		if (matchesKey(data, "up")) {
			this.settingsIndex = Math.max(0, this.settingsIndex - 1);
		} else if (matchesKey(data, "down")) {
			this.settingsIndex = Math.min(FOOTER_SETTING_ITEMS.length - 1, this.settingsIndex + 1);
		} else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
			const item = FOOTER_SETTING_ITEMS[this.settingsIndex];
			if (item) {
				this.footerSettings = { ...this.footerSettings, [item.key]: !this.footerSettings[item.key] };
				saveFooterSettings(this.footerSettings);
				this.onSettingsChange(this.footerSettings);
			}
		} else {
			return false;
		}
		this.requestRender();
		return true;
	}

	private handleHistoryInput(data: string): boolean {
		if (this.historySelected && (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter"))) return this.handleInsightInput(data);
		const sessions = Array.from(this.data.sessions.values()).sort((a, b) => b.timestamp - a.timestamp);
		if (matchesKey(data, "up")) this.historyIndex = Math.max(0, this.historyIndex - 1);
		else if (matchesKey(data, "down")) this.historyIndex = Math.min(Math.max(0, sessions.length - 1), this.historyIndex + 1);
		else if (matchesKey(data, "enter")) {
			const session = sessions[this.historyIndex];
			const prompt = session ? loadPromptSnapshot(session.id) ?? this.currentPrompt : null;
			if (!session || !prompt) return true;
			this.historySelected = session.id;
			this.promptSections = promptSections(prompt);
			this.insightDetail = null;
			this.insightContent = null;
			this.insightIndex = 0;
		} else return false;
		this.requestRender();
		return true;
	}

	private exportCurrentView(): void {
		const now = new Date();
		let name: string;
		let content: string;
		const stats = this.data[this.activeTab];
		if (this.viewMode === "graph") {
			const slice = `${this.viewMode}-${this.graphCumulative ? "cumulative" : "per-bucket"}-${this.graphMetric}-by-${this.graphGroupBy}`;
			name = exportFileName("graph", this.activeTab, slice, "csv", now);
			content = buildGraphCsv(this.buildGraphModelForView());
		} else if (this.viewMode === "insights") {
			name = exportFileName("insights", this.activeTab, null, "json", now);
			content = buildInsightsJson(this.activeTab, stats.totals, stats.insights.insights);
		} else {
			const visible = this.visibleTable();
			const sliced = this.tableFilter.trim() !== "" || this.tableHidden.size > 0;
			name = exportFileName("table", this.activeTab, sliced ? "filtered" : null, "csv", now);
			content = buildTableCsv(visible.providers, visible.totals);
		}
		try {
			let configured: string | null = null;
			try {
				configured = parseExportDirSetting(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
			} catch {
				// No settings file or unreadable: fall through to the default dir.
			}
			const home = homedir();
			const dir = resolveExportDir(configured, home, existsSync("/tmp"), tmpdir());
			mkdirSync(dir, { recursive: true });
			const path = join(dir, name);
			writeFileSync(path, content);
			const shown = path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
			this.exportNote = { text: `Saved ${shown}`, ok: true };
		} catch (err) {
			this.exportNote = { text: `Export failed: ${err instanceof Error ? err.message : String(err)}`, ok: false };
		}
	}

	private buildGraphModelForView(): GraphModel {
		const hourly = new Map(Array.from(this.data.hourly, ([hour, cells]) => [
			hour,
			new Map(Array.from(cells).filter(([key]) => splitHourlyKey(key).provider !== AUXILIARY_PROVIDER)),
		]));
		return buildGraphModel(hourly, {
			period: this.activeTab,
			metric: this.graphMetric,
			groupBy: this.graphGroupBy,
			cumulative: this.graphCumulative,
			hidden: this.graphHidden,
			bounds: this.data.bounds,
		});
	}

	render(width: number): string[] {
		if (this.viewMode === "graph") {
			return clampLines(
				[...this.renderTitle(width), ...this.renderTabs(width, getTableLayout(width)), ...this.renderGraph(width), ...this.renderHelp(width)],
				width
			);
		}

		if (this.viewMode === "insights") {
			return clampLines([...this.renderTitle(width), ...this.renderInsights(width), ...this.renderHelp(width)], width);
		}

		if (this.viewMode === "history") {
			return clampLines([...this.renderTitle(width), ...this.renderHistory(width)], width);
		}

		if (this.viewMode === "settings") {
			return clampLines([...this.renderTitle(width), ...this.renderSettings(width)], width);
		}

		const layout = getTableLayout(width);
		return clampLines(
			[
				...this.renderTitle(width),
				...this.renderTabs(width, layout),
				...this.renderHeader(layout),
				...this.renderRows(layout),
				...this.renderTotals(layout),
				...this.renderFormulaNote(width),
				...this.renderHelp(width),
			],
			width
		);
	}

	private renderTitle(width: number): string[] {
		const th = this.theme;
		const fullStrip = VIEW_CYCLE.map((view) =>
			view === this.viewMode ? th.fg("accent", `[${VIEW_LABELS[view]}]`) : th.fg("dim", ` ${VIEW_LABELS[view]} `)
		).join(" ");
		const activeOnly = th.fg("accent", `[${VIEW_LABELS[this.viewMode]}]`);
		const line = pickFittingText(width, [fullStrip, activeOnly]);
		return [line, ""];
	}

	private renderOverviewSummary(width: number): string[] {
		const th = this.theme, totals = this.visibleTable().totals;
		const summary = th.fg("thinkingHigh", "Usage:") + " " + th.fg("accent", formatCost(totals.cost)) + " · " + th.fg("text", `${formatTokens(totals.tokens.total)} tokens`) + " · " + th.fg("success", `↑${formatTokens(totals.tokens.input + totals.tokens.cacheWrite)}`) + " · " + th.fg("warning", `↓${formatTokens(totals.tokens.output)}`) + " · " + th.fg("thinkingHigh", `${formatTokens(totals.tokens.cacheRead + totals.tokens.cacheWrite)} cache`);
		const stats = th.fg("dim", "Total cost ") + th.fg("accent", formatCost(totals.cost)) + th.fg("dim", "     Tokens ") + th.fg("warning", formatTokens(totals.tokens.total)) + th.fg("dim", "     Messages ") + th.fg("success", formatNumber(totals.messages)) + th.fg("dim", "     Sessions ") + th.fg("thinkingHigh", formatNumber(totals.sessions));
		return [truncateToWidth(summary, width), truncateToWidth(stats, width), ""];
	}

	private buildDailyProviderModel(): { days: { label: string; total: number; providers: Map<string, number> }[]; providers: { name: string; total: number; tokens: number; models: { name: string; cost: number; tokens: number; value: number }[] }[]; max: number; total: number } {
		const now = this.data.bounds.nowMs;
		const start = this.activeTab === "today" ? this.data.bounds.todayMs : this.activeTab === "thisWeek" ? this.data.bounds.weekStartMs : this.activeTab === "lastWeek" ? this.data.bounds.lastWeekStartMs : this.activeTab === "last30Days" ? this.data.bounds.last30DaysStartMs : Math.min(...this.data.hourly.keys(), this.data.bounds.todayMs);
		const end = this.activeTab === "lastWeek" ? this.data.bounds.weekStartMs : now;
		const dayMs = 24 * 3_600_000;
		const valueOf = (cell: { cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }) => cell.cost;
		const days: { label: string; total: number; providers: Map<string, number> }[] = [];
		for (let t = start; t < end; t += dayMs) {
			const date = new Date(t);
			days.push({ label: `${date.getMonth() + 1}/${date.getDate()}`, total: 0, providers: new Map() });
		}
		const providerTotals = new Map<string, number>();
		const modelTotals = new Map<string, Map<string, { cost: number; tokens: number; value: number }>>();
		for (const [hour, cells] of this.data.hourly) {
			if (hour < start || hour >= end) continue;
			const day = days[Math.min(days.length - 1, Math.floor((hour - start) / dayMs))];
			if (!day) continue;
			for (const [key, cell] of cells) {
				const { provider, model } = splitHourlyKey(key);
				if (provider === AUXILIARY_PROVIDER) continue;
				const tokens = cell.input + cell.output + cell.cacheRead + cell.cacheWrite;
				const value = valueOf(cell);
				day.providers.set(provider, (day.providers.get(provider) ?? 0) + value);
				day.total += value;
				providerTotals.set(provider, (providerTotals.get(provider) ?? 0) + value);
				let byModel = modelTotals.get(provider);
				if (!byModel) {
					byModel = new Map();
					modelTotals.set(provider, byModel);
				}
				const modelTotal = byModel.get(model) ?? { cost: 0, tokens: 0, value: 0 };
				modelTotal.cost += cell.cost;
				modelTotal.tokens += tokens;
				modelTotal.value += value;
				byModel.set(model, modelTotal);
			}
		}
		const providers = [...providerTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, total]) => {
			const models = [...(modelTotals.get(name) ?? new Map()).entries()].sort((a, b) => b[1].value - a[1].value).map(([modelName, stats]) => ({ name: modelName, ...stats }));
			return { name, total, tokens: models.reduce((sum, model) => sum + model.tokens, 0), models };
		});
		return { days, providers, max: Math.max(0, ...days.map((d) => d.total)), total: days.reduce((sum, d) => sum + d.total, 0) };
	}

	private renderGraph(width: number): string[] {
		const th = this.theme;
		const model = this.buildDailyProviderModel();
		const formatValue = formatAxisCost;
		const lines: string[] = [...this.renderOverviewSummary(width), th.fg("muted", "Daily total cost · by provider"), ""];
		if (model.total === 0) return [...lines, th.fg("dim", "  No usage data for this period"), ""];

		const labelW = Math.max(formatValue(model.max).length, 3);
		const slotW = 6;
		const plotW = Math.max(1, Math.min(Math.floor((width - labelW - 2) / slotW), model.days.length));
		const start = Math.max(0, model.days.length - plotW);
		const days = model.days.slice(start);
		const axisW = Math.max(0, days.length * slotW - 1);
		const height = 8;
		for (let row = height; row >= 1; row--) {
			const threshold = (model.max * row) / height;
			let line = th.fg("dim", `${row === height ? formatValue(model.max) : row === 1 ? formatValue(0) : ""}`.padStart(labelW) + " │");
			for (let d = 0; d < days.length; d++) {
				const day = days[d]!;
				let acc = 0, owner = -1;
				for (let i = 0; i < model.providers.length; i++) {
					const p = model.providers[i]!;
					if (this.graphHidden.has(p.name)) continue;
					acc += day.providers.get(p.name) ?? 0;
					if (acc >= threshold) { owner = i; break; }
				}
				line += (owner < 0 ? " " : seriesColor(owner) + "█" + COLOR_RESET) + " ".repeat(d === days.length - 1 ? 0 : slotW - 1);
			}
			lines.push(line);
		}
		lines.push(th.fg("dim", " ".repeat(labelW) + " └" + Array.from({ length: axisW }, (_, i) => i % slotW === 0 ? "┬" : "─").join("")));
		lines.push(th.fg("dim", " ".repeat(labelW + 2) + days.map((day) => day.label.padEnd(slotW)).join("").trimEnd()));
		lines.push("");
		const detail = model.providers.find((p) => p.name === this.graphDetailProvider);
		const rows = detail?.models.slice(0, 8) ?? [];
		const providerWidth = Math.max(24, ...model.providers.map((p) => visibleWidth(p.name)), ...rows.map((m) => visibleWidth(m.name)));
		const costWidth = Math.max(visibleWidth("Cost ($)"), ...model.providers.map((p) => visibleWidth(formatValue(p.total))), ...rows.map((m) => visibleWidth(formatAxisCost(m.cost))));
		const tokenWidth = Math.max(visibleWidth("Token usage"), ...model.providers.map((p) => visibleWidth(formatTokens(p.tokens))), ...rows.map((m) => visibleWidth(formatTokens(m.tokens))));
		const treeIndent = "  ";
		lines.push(th.fg("muted", `${treeIndent}    ${padRight("Model", providerWidth)} ${padLeft("Cost ($)", costWidth)}  ${padLeft("Token usage", tokenWidth)}`));
		for (let i = 0; i < model.providers.length; i++) {
			const p = model.providers[i]!;
			const cursor = i === this.graphLegendIndex ? th.fg("accent", "▸ ") : "  ";
			const name = this.graphHidden.has(p.name) ? th.fg("dim", p.name) : i === this.graphLegendIndex ? th.fg("accent", p.name) : p.name;
			lines.push(`${treeIndent}${cursor}${padRight(name, providerWidth + 2)} ${padLeft(formatValue(p.total), costWidth)}  ${padLeft(formatTokens(p.tokens), tokenWidth)}`);
			if (p !== detail) continue;
			for (let j = 0; j < rows.length; j++) {
				const m = rows[j]!;
				const branch = j === rows.length - 1 ? "└" : "├";
				lines.push(th.fg("muted", `${treeIndent}  ${branch} ${padRight(truncateToWidth(m.name, providerWidth), providerWidth)} ${padLeft(formatAxisCost(m.cost), costWidth)}  ${padLeft(formatTokens(m.tokens), tokenWidth)}`));
			}
		}
		lines.push("");
		return lines;
	}


	private renderInsights(width: number): string[] {
		const th = this.theme;
		if (this.insightContent) {
			return [th.bold(this.insightContent.label), th.fg("dim", `${formatNumber(this.insightContent.chars)} chars · Esc back`), "", ...previewText(this.insightContent.text, width, 24).map((line) => th.fg("dim", line)), ""];
		}
		const detail = this.insightDetail;
		const rows = detail ? detail.children : this.promptSections;
		const total = detail ? detail.chars : this.promptSections.reduce((sum, section) => sum + section.chars, 0);
		const source = this.historySelected ? `History ${this.historySelected.slice(0, 8)}` : "Current session";
		const lines = [th.bold(detail ? `${detail.label} sources` : `${source} prompt sources`), th.fg("dim", detail ? "Esc back · source sizes" : "Assembled system prompt · source sizes · Enter details"), ""];
		const colors: ("accent" | "success" | "warning" | "thinkingHigh")[] = ["accent", "success", "warning", "thinkingHigh"];
		if (!detail) {
			const widthBar = Math.max(20, Math.min(width - 4, 60));
			let bar = "";
			for (let i = 0; i < rows.length; i++) {
				if (i > 0) bar += " ";
				bar += th.fg(colors[i % colors.length]!, "▬".repeat(Math.round(rows[i]!.chars / Math.max(total, 1) * widthBar)));
			}
			lines.push(bar, "");
		}
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i]!;
			const chars = row.chars;
			const pct = total ? `${(chars / total * 100).toFixed(1)}%` : "0.0%";
			const selected = i === this.insightIndex;
			const marker = selected ? th.fg("accent", "▸ ") : th.fg("dim", "· ");
			const indicator = detail ? "" : th.fg(colors[i % colors.length]!, "■ ");
			const suffix = th.fg("dim", `${formatNumber(chars)} chars  ${pct}`);
			lines.push(`${marker}${indicator}${selected ? th.fg("accent", row.label) : row.label}${" ".repeat(Math.max(1, width - visibleWidth(marker + indicator + row.label + suffix)))}${suffix}`);
		}
		lines.push("", th.fg("dim", "[↑↓] select  [Enter] open  [Esc] back"));
		return lines;
	}

	private renderCostInsights(width: number): string[] {
		const th = this.theme;
		const stats = this.data[this.activeTab];
		const { insights } = stats.insights;
		const hasUsage =
			stats.totals.messages > 0 ||
			stats.totals.cost > 0 ||
			stats.totals.tokens.total > 0 ||
			stats.totals.tokens.cacheRead > 0;
		const hasCost = stats.totals.cost > 0;
		const lines: string[] = [];

		// Cap the content column so advice stays readable on very wide terminals.
		const contentWidth = Math.max(Math.min(width, 100), 40);

		lines.push(th.bold("What's contributing to your cost?"));
		const subtitle = "Approximate, based on local sessions on this machine (these are independent and don't sum to 100%).";
		for (const wrapped of wrapTextWithAnsi(subtitle, contentWidth)) {
			lines.push(th.fg("dim", wrapped));
		}
		lines.push("");

		if (!hasUsage) {
			lines.push(th.fg("dim", "  No usage recorded for this period."));
			lines.push("");
			return lines;
		}
		if (!hasCost) {
			lines.push(th.fg("dim", "  No cost data recorded for this period."));
			lines.push("");
			return lines;
		}
		if (insights.length === 0) {
			lines.push(th.fg("dim", "  Nothing notable for this period."));
			lines.push("");
			return lines;
		}

		// Columns: marker(2) + stat(6) + gap(1); advice aligns under the headline.
		const indent = "         ";
		const adviceWidth = Math.max(contentWidth - indent.length, 30);

		const sectionHeader = (label: string, color: "warning" | "accent"): string => {
			const rule = "─".repeat(Math.max(contentWidth - label.length - 1, 4));
			return `${th.fg(color, th.bold(label))} ${th.fg("border", rule)}`;
		};

		const renderOne = (insight: (typeof insights)[number]): void => {
			const isAlarm = insight.kind === "alarm";
			const marker = isAlarm ? th.fg("warning", "⚠ ") : "  ";
			const statText = padLeft(insight.stat, 6);
			const stat = isAlarm ? th.fg("warning", th.bold(statText)) : th.fg("accent", th.bold(statText));
			// De-emphasise the trailing period-share parenthetical on alarm headlines.
			const match = insight.headline.match(/^(.*?)\s*(\(\d[\d.,]*% of this period\))$/);
			const headline = match ? `${match[1]} ${th.fg("dim", match[2]!)}` : insight.headline;
			lines.push(`${marker}${stat} ${headline}`);
			if (insight.advice) {
				for (const wrapped of wrapTextWithAnsi(insight.advice, adviceWidth)) {
					lines.push(`${indent}${th.fg("dim", wrapped)}`);
				}
			}
			lines.push("");
		};

		const alarms = insights.filter((i) => i.kind === "alarm");
		const structure = insights.filter((i) => i.kind === "structure");
		// Facts first, flagged waste second.
		if (structure.length > 0) {
			lines.push(sectionHeader("Where it went", "accent"));
			for (const insight of structure) renderOne(insight);
		}
		lines.push(sectionHeader("Worth attention", "warning"));
		if (alarms.length > 0) {
			for (const insight of alarms) renderOne(insight);
		} else {
			lines.push(`  ${th.fg("success", padLeft("✓", 6))} ${th.fg("dim", "no waste patterns flagged for this period")}`);
			lines.push("");
		}

		return lines;
	}

	private renderHistory(width: number): string[] {
		const th = this.theme;
		const sessions = Array.from(this.data.sessions.values()).sort((a, b) => b.timestamp - a.timestamp);
		const lines = [th.bold("Session history"), th.fg("dim", "Assistant usage only — tools/summaries excluded · Enter selects"), ""];
		const selected = sessions.find((session) => session.id === this.historySelected);
		if (selected) {
			lines.push(th.fg("accent", `Selected ${selected.id.slice(0, 8)} · ${selected.cwd || "unknown project"}`));
			lines.push(`  ${formatTokens(selected.tokens.total)} tokens · ↑${formatTokens(selected.tokens.input + selected.tokens.cacheWrite)} input · ↓${formatTokens(selected.tokens.output)} output · ${formatTokens(selected.tokens.cacheRead)} cache · ${formatCost(selected.cost)}`, "");
			lines.push(...this.renderInsights(width));
			return lines;
		}
		for (let i = 0; i < sessions.length; i++) {
			const session = sessions[i]!;
			const marker = i === this.historyIndex ? th.fg("accent", "▸ ") : th.fg("dim", "· ");
			const label = `${new Date(session.timestamp).toLocaleString()}  ${session.cwd || "unknown"}`;
			const saved = loadPromptSnapshot(session.id) !== null || session.id === this.currentSessionId;
			const suffix = th.fg(saved ? "success" : "dim", `${saved ? "burden" : "no snapshot"}  ${formatTokens(session.tokens.total)}  ${session.messages} msgs`);
			lines.push(`${marker}${truncateToWidth(label, Math.max(12, width - visibleWidth(marker + suffix) - 2))} ${suffix}`);
		}
		if (!sessions.length) lines.push(th.fg("dim", "No session usage recorded."));
		lines.push("", th.fg("dim", "[↑↓] choose  [Enter] run burden  [Tab] view  [q] close"));
		return lines;
	}

	private renderTabs(width: number, layout: TableLayout): string[] {
		const th = this.theme;
		const fullTabs = TAB_ORDER.map((tab) => {
			const label = TAB_LABELS[tab];
			return tab === this.activeTab ? th.fg("accent", `[${label}]`) : th.fg("dim", ` ${label} `);
		}).join("  ");

		const activeTabOnly = th.fg("accent", `[${TAB_LABELS[this.activeTab]}]`);
		const tabLine = pickFittingText(width, [
			fullTabs,
			`${activeTabOnly}  ${th.fg("dim", "[←→]")}`, 
			activeTabOnly,
		]);

		// Compact-note only applies to the table view — it's meaningless for insights.
		const infoLines =
			this.viewMode === "table" && layout.compact
				? wrapTextWithAnsi(th.fg("dim", "Compact view. Widen the terminal for more columns."), Math.max(width, 1))
				: [];

		if (this.viewMode === "table") {
			if (this.tableFilterEditing) {
				infoLines.push(`${th.fg("accent", `/ ${this.tableFilter}▌`)}  ${th.fg("dim", "[Enter] keep · [Esc] clear")}`);
			} else if (this.tableFilter.trim() !== "" || this.tableHidden.size > 0) {
				const parts: string[] = [];
				if (this.tableFilter.trim() !== "") parts.push(`filter: “${this.tableFilter.trim()}”`);
				if (this.tableHidden.size > 0) parts.push(`${this.tableHidden.size} hidden`);
				infoLines.push(th.fg("warning", `${parts.join(" · ")}  ·  totals reflect this slice · [a] reset`));
			}
		}

		return [tabLine, ...infoLines, ""];
	}

	private renderHeader(layout: TableLayout): string[] {
		const th = this.theme;

		let headerLine = fitCell("Provider / Model", layout.nameWidth);
		for (const col of layout.columns) {
			const label = fitCell(col.label, col.width, "right");
			headerLine += col.dimmed ? th.fg("dim", label) : label;
		}

		return [th.fg("muted", headerLine), th.fg("border", "─".repeat(layout.tableWidth))];
	}

	private renderDataRow(
		name: string,
		stats: BaseStats & { sessions: Set<string> | number },
		layout: TableLayout,
		options: { indent?: number; selected?: boolean; dimAll?: boolean; prefix?: string } = {}
	): string {
		const th = this.theme;
		const { indent = 0, selected = false, dimAll = false, prefix } = options;

		const rawPrefix = prefix ?? " ".repeat(indent);
		const safePrefix = layout.nameWidth > 0 ? truncateToWidth(rawPrefix, layout.nameWidth, "") : "";
		const prefixWidth = visibleWidth(safePrefix);
		const innerNameWidth = Math.max(layout.nameWidth - prefixWidth, 0);
		const truncName = innerNameWidth > 0 ? truncateToWidth(name, innerNameWidth) : "";
		const styledName = selected ? th.fg("accent", truncName) : dimAll ? th.fg("dim", truncName) : truncName;

		let row = safePrefix + (innerNameWidth > 0 ? padRight(styledName, innerNameWidth) : "");

		for (const col of layout.columns) {
			const value = fitCell(col.getValue(stats), col.width, "right");
			const shouldDim = col.dimmed || dimAll;
			row += shouldDim ? th.fg("dim", value) : value;
		}

		return row;
	}

	private renderRows(layout: TableLayout): string[] {
		const th = this.theme;
		const lines: string[] = [];

		if (this.providerOrder.length === 0) {
			lines.push(th.fg("dim", "  No usage data for this period"));
			return lines;
		}

		const visible = Array.from(this.visibleTable().providers.entries());
		if (visible.length === 0) {
			lines.push(th.fg("dim", "  Nothing matches the current filter — [a] resets"));
			return lines;
		}

		for (let i = 0; i < visible.length; i++) {
			const [providerName, providerStats] = visible[i]!;
			const isSelected = i === this.selectedIndex;
			const isExpanded = this.expanded.has(providerName);
			const arrow = isExpanded ? "▾" : "▸";
			const prefix = isSelected ? th.fg("accent", `${arrow} `) : th.fg("dim", `${arrow} `);

			lines.push(
				this.renderDataRow(providerName, providerStats, layout, {
					selected: isSelected,
					prefix,
				})
			);

			if (isExpanded) {
				const models = Array.from(providerStats.models.entries()).sort((a, b) => b[1].cost - a[1].cost);

				for (const [modelName, modelStats] of models) {
					lines.push(this.renderDataRow(modelName, modelStats, layout, { indent: 4, dimAll: true }));
				}
			}
		}

		return lines;
	}

	private renderTotals(layout: TableLayout): string[] {
		const th = this.theme;
		const { totals } = this.visibleTable();

		let totalRow = fitCell(th.bold("Total"), layout.nameWidth);
		for (const col of layout.columns) {
			const value = fitCell(col.getValue(totals), col.width, "right");
			totalRow += col.dimmed ? th.fg("dim", value) : value;
		}

		return [th.fg("border", "─".repeat(layout.tableWidth)), totalRow, ""];
	}

	private renderSettings(width: number): string[] {
		const th = this.theme;
		const lines = [th.bold("Footer display settings"), th.fg("dim", "Choose what appears in the usage footer · changes apply immediately"), ""];
		for (let i = 0; i < FOOTER_SETTING_ITEMS.length; i++) {
			const item = FOOTER_SETTING_ITEMS[i]!;
			const selected = i === this.settingsIndex;
			const checked = this.footerSettings[item.key] ? th.fg("success", "☑") : th.fg("dim", "☐");
			const marker = selected ? th.fg("accent", "▸ ") : "  ";
			const label = selected ? th.fg("accent", item.label) : item.label;
			lines.push(`${marker}${checked} ${label}  ${th.fg("dim", item.description)}`);
		}
		lines.push("", th.fg("dim", "[↑↓] select  [Enter/Space] toggle  [Tab] view  [q] close"));
		return lines;
	}

	private renderFormulaNote(width: number): string[] {
		const line = pickFittingText(width, [
			"Tokens = Input + Output + CacheWrite  ·  ↑In = Input + CacheWrite  (as of 0.2.0)",
			"Tokens = In + Out + CacheWrite  ·  ↑In = In + CacheWrite  (v0.2.0+)",
			"Tokens & ↑In include CacheWrite (v0.2.0+)",
			"Incl. CacheWrite (v0.2.0+)",
		]);
		return [this.theme.fg("dim", line), ""];
	}

	private renderHelp(width: number): string[] {
		const noteLines = this.exportNote
			? [this.theme.fg(this.exportNote.ok ? "success" : "error", `${this.exportNote.ok ? "✓" : "✗"} ${this.exportNote.text}`), ""]
			: [];
		const variants =
			this.viewMode === "graph"
				? [
						"[Tab] view  [←→] period  [↑↓] select  [Enter/click] models  [Space] hide  [e] export  [q] close",
						"[←→] period  [↑↓] select  [Enter] models  [q] close",
						"[Enter] models  [q] close",
						"[q] close",
				  ]
				: this.viewMode === "insights"
				? [
						"[Tab] view  [←→] period  [↑↓] select  [e] export  [q] close",
						"[←→] period  [↑↓] select  [e] export  [q] close",
						"[↑↓] select  [q] close",
						"[q] close",
				  ]
				: [
						"[Tab] view  [←→] period  [↑↓] select  [Enter] expand  [/] filter  [x] hide  [a] all  [e] export  [q] close",
						"[←→] period  [↑↓] select  [Enter] expand  [/] filter  [x] hide  [e] export  [q] close",
						"[↑↓] select  [Enter] expand  [/] filter  [x] hide  [q] close",
						"[↑↓] select  [/] [x] [q]",
						"[↑↓] select  [q] close",
						"[q] close",
				  ];
		const line = pickFittingText(width, variants);
		return [...noteLines, this.theme.fg("dim", line)];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.viewMode !== "graph" || event.type !== "click" || event.button !== "left") return undefined;
		const legendStart = 20;
		const idx = event.y - legendStart;
		const providers = this.buildDailyProviderModel().providers;
		if (idx < 0 || idx >= providers.length) return undefined;
		const target = providers[idx]!;
		this.graphLegendIndex = idx;
		this.graphDetailProvider = this.graphDetailProvider === target.name ? null : target.name;
		this.requestRender();
		return { handled: true, render: true };
	}

	invalidate(): void {}
	dispose(): void {}
}

// =============================================================================
// Extension Entry Point
// =============================================================================

function footerModelLabel(ctx: Pick<ExtensionCommandContext, "model" | "thinkingLevel">): string {
	const model = ctx.model;
	if (!model) return "no-model";
	const label = `(${model.provider}) ${model.id}`;
	return model.reasoning && ctx.thinkingLevel ? `${label} • ${ctx.thinkingLevel}` : label;
}

function setUsageFooter(ctx: Pick<ExtensionCommandContext, "ui" | "model" | "thinkingLevel" | "getContextUsage">, totals: TotalStats, sessionTotals: TotalStats | null, settings: FooterSettings): void {
	ctx.ui.setFooter((_tui, theme) => ({
		invalidate() {},
		render(width: number): string[] {
			const context = ctx.getContextUsage();
			const compactAt = context ? context.contextWindow - 16_384 : 0;
			const left = context?.tokens === null ? "?" : context ? formatTokens(Math.max(0, compactAt - context.tokens)) : "?";
			const contextStatus = settings.showContext && context
				? " · " + theme.fg("warning", `${context.percent?.toFixed(1) ?? "?"}%`) + theme.fg("dim", "/") + theme.fg("success", `${left} left`) + " " + theme.fg("accent", "(auto)")
				: "";
			const bodyParts: string[] = [];
			if (settings.showSession && sessionTotals) {
				bodyParts.push(theme.fg("success", "(Session)") + " · " + theme.fg("accent", formatCost(sessionTotals.cost)) + " · " + theme.fg("text", `${formatTokens(sessionTotals.tokens.total)} tokens`) + " · " + theme.fg("success", `↑${formatTokens(sessionTotals.tokens.input + sessionTotals.tokens.cacheWrite)}`) + " · " + theme.fg("warning", `↓${formatTokens(sessionTotals.tokens.output)}`));
			}
			if (settings.showToday) {
				bodyParts.push(theme.fg("accent", "(Today)") + " · " + theme.fg("accent", formatCost(totals.cost)) + " · " + theme.fg("text", `${formatTokens(totals.tokens.total)} tokens`) + " · " + theme.fg("success", `↑${formatTokens(totals.tokens.input + totals.tokens.cacheWrite)}`) + " · " + theme.fg("warning", `↓${formatTokens(totals.tokens.output)}`) + " · " + theme.fg("thinkingHigh", `${formatTokens(totals.tokens.cacheRead + totals.tokens.cacheWrite)} cache`));
			}
			const usage = (bodyParts.length ? bodyParts.join("  ") : "") + contextStatus;
			const model = theme.fg("accent", footerModelLabel(ctx));
			const gap = width - visibleWidth(usage) - visibleWidth(model);
			return [gap >= 2 ? usage + " ".repeat(gap) + model : truncateToWidth(usage, width)];
		},
	}));
}

export default function (pi: ExtensionAPI) {
	let sessionTotals: TotalStats = { sessions: 0, messages: 0, cost: 0, tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	let footerSettings = loadFooterSettings();

	const refreshFooter = (ctx: Pick<ExtensionCommandContext, "hasUI" | "ui" | "model" | "thinkingLevel" | "getContextUsage">) => {
		if (!ctx.hasUI) return;
		void collectUsageData().then((data) => {
			if (!data) return;
			const providers = Array.from(data.today.providers).filter(([name]) => name !== AUXILIARY_PROVIDER).map(([, stats]) => stats);
			const totals: TotalStats = { sessions: new Set(providers.flatMap((p) => Array.from(p.sessions))).size, messages: 0, cost: 0, tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
			for (const stats of providers) {
				totals.messages += stats.messages; totals.cost += stats.cost;
				totals.tokens.total += stats.tokens.total; totals.tokens.input += stats.tokens.input; totals.tokens.output += stats.tokens.output; totals.tokens.cacheRead += stats.tokens.cacheRead; totals.tokens.cacheWrite += stats.tokens.cacheWrite;
			}
			setUsageFooter(ctx, totals, sessionTotals, footerSettings);
		});
	};
	const snapshotPrompt = (ctx: { sessionManager: { getSessionId(): string }; getSystemPrompt(): string }) => {
		try { savePromptSnapshot(ctx.sessionManager.getSessionId(), ctx.getSystemPrompt()); } catch { /* usage must never block Pi */ }
	};
	pi.on("session_start", (_event, ctx) => {
		sessionTotals = { sessions: 0, messages: 0, cost: 0, tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		snapshotPrompt(ctx);
		refreshFooter(ctx);
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") {
			const u = event.message.usage;
			sessionTotals.messages++;
			sessionTotals.cost += u.cost.total;
			sessionTotals.tokens.total += u.totalTokens;
			sessionTotals.tokens.input += u.input;
			sessionTotals.tokens.output += u.output;
			sessionTotals.tokens.cacheRead += u.cacheRead;
			sessionTotals.tokens.cacheWrite += u.cacheWrite;
		}
		snapshotPrompt(ctx);
		refreshFooter(ctx);
	});
	pi.on("model_select", (_event, ctx) => { refreshFooter(ctx); });
	pi.registerCommand("usage", {
		description: "Show usage statistics dashboard",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			try { savePromptSnapshot(ctx.sessionManager.getSessionId(), ctx.getSystemPrompt()); } catch { /* continue without history snapshot */ }
			if (!ctx.hasUI) {
				return;
			}

			const data = await ctx.ui.custom<UsageData | null>((tui, theme, _kb, done) => {
				const loader = new CancellableLoader(
					tui,
					(s: string) => theme.fg("accent", s),
					(s: string) => theme.fg("muted", s),
					"Loading Usage..."
				);
				let finished = false;
				const finish = (value: UsageData | null) => {
					if (finished) return;
					finished = true;
					loader.dispose();
					done(value);
				};

				loader.onAbort = () => finish(null);

				const onProgress = (p: CollectProgress): void => {
					if (finished || p.filesToParse === 0) return;
					const files = `${p.filesParsed.toLocaleString()}/${p.filesToParse.toLocaleString()} files`;
					if (p.mode === "update") {
						const since = p.sinceMs !== null ? ` since ${formatSinceDate(p.sinceMs)}` : "";
						loader.setMessage(`Updating your usage history${since}… (${files})`);
					} else if (p.mode === "rebuild") {
						loader.setMessage(`Rebuilding your usage history — the cache format changed… (${files})`);
					} else {
						loader.setMessage(`Building your usage history for the first time… (${files})`);
					}
				};

				collectUsageData({ signal: loader.signal, onProgress })
					.then(finish)
					.catch(() => finish(null));

				return loader;
			});

			if (!data) {
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const container = new Container();

				// Top border
				container.addChild(new Spacer(1));
				container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
				container.addChild(new Spacer(1));

				const usage = new UsageComponent(theme, data, ctx.getSystemPrompt(), ctx.sessionManager.getSessionId(), () => tui.requestRender(), () => done(), footerSettings, (newSettings) => { footerSettings = newSettings; refreshFooter(ctx); });

				return {
					render: (w: number) => {
						const borderLines = clampLines(container.render(w), w);
						const usageLines = usage.render(w);
						const bottomBorder = theme.fg("border", "─".repeat(w));
						return clampLines([...borderLines, ...usageLines, "", bottomBorder], w);
					},
					invalidate: () => container.invalidate(),
					handleInput: (input: string) => usage.handleInput(input),
					handleMouse: (event: TuiMouseEvent) => usage.handleMouse({ ...event, y: event.y - 3 }),
					dispose: () => {},
				};
			});
		},
	});
}
