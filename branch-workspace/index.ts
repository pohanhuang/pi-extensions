import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";

const MODES = ["read-only", "edit"] as const;
type Mode = (typeof MODES)[number];

const WORKSPACE_TEMPLATE = `# Plan

<!-- What problem does this branch solve, and what is the approach? -->

# Discussion

<!-- Notes, tradeoffs, and decisions made. -->

# Progress

Not started.

# Next

<!-- Next steps and open tasks. -->
`;

const AGENTS_TEMPLATE = "# Agent Instructions\n\n<!-- Shared behavior and constraints for this repository. -->\n";
const CHANGES_TEMPLATE = "# Changes\n\n<!-- Auto-generated commit log. -->\n";

// =============================================================================
// Git / workspace helpers
// =============================================================================

function branch(cwd: string): string {
	try {
		return execSync("git symbolic-ref --quiet --short HEAD", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "detached";
	} catch { return "main"; }
}

function workspaceDir(cwd: string): string {
	return join(cwd, ".pi", branch(cwd).replace(/[\\/]/g, "-"));
}

function writeMissing(path: string, content: string): void {
	if (!existsSync(path)) writeFileSync(path, content, "utf8");
}

function read(path: string): string {
	return readFileSync(path, "utf8").trimEnd();
}

function normalizeMode(value: string): Mode {
	const m = value.trim();
	// Migrate legacy mode names
	if (m === "discuss") return "read-only";
	if (m === "implement") return "edit";
	return (MODES as readonly string[]).includes(m) ? (m as Mode) : "read-only";
}

/** Parse H1 section names from workspace.md */
function parseHeaders(wsFile: string): string[] {
	try {
		return [...readFileSync(wsFile, "utf8").matchAll(/^# (.+)$/gm)].map(m => m[1]!.trim());
	} catch { return []; }
}

/** Migrate old plan/discuss/implementation.md → workspace.md */
function migrateWorkspace(dir: string): void {
	const wsFile = join(dir, "workspace.md");
	if (existsSync(wsFile)) return;
	const OLD = [
		{ file: "plan.md", header: "# Plan" },
		{ file: "discuss.md", header: "# Discussion" },
		{ file: "implementation.md", header: "# Progress" },
	];
	const parts: string[] = [];
	for (const { file, header } of OLD) {
		const p = join(dir, file);
		if (!existsSync(p)) continue;
		const body = readFileSync(p, "utf8").trim();
		if (body && body !== header) parts.push(body);
	}
	writeFileSync(wsFile, parts.length ? parts.join("\n\n") + "\n" : WORKSPACE_TEMPLATE, "utf8");
}

function ensure(cwd: string): { dir: string; wsFile: string; changesFile: string; mode: Mode; reset: boolean } {
	const dir = workspaceDir(cwd);
	mkdirSync(dir, { recursive: true });
	writeMissing(join(cwd, ".pi", "agents.md"), AGENTS_TEMPLATE);
	migrateWorkspace(dir);
	const wsFile = join(dir, "workspace.md");
	const changesFile = join(dir, "changes.md");
	writeMissing(changesFile, CHANGES_TEMPLATE);

	const modePath = join(dir, ".mode");
	let reset = false;
	if (!existsSync(modePath)) writeFileSync(modePath, "read-only\n", "utf8");
	const raw = readFileSync(modePath, "utf8");
	const mode = normalizeMode(raw);
	if (mode !== raw.trim()) { writeFileSync(modePath, "read-only\n", "utf8"); reset = true; }
	return { dir, wsFile, changesFile, mode, reset };
}

function isWorkspaceFile(cwd: string, filePath: string | undefined): boolean {
	if (!filePath) return false;
	return resolve(cwd, filePath) === resolve(join(workspaceDir(cwd), "workspace.md"));
}

function isModeFile(cwd: string, filePath: string | undefined): boolean {
	if (!filePath) return false;
	return resolve(cwd, filePath) === resolve(join(workspaceDir(cwd), ".mode"));
}

function writesModeViaBash(command: string): boolean {
	return /\.mode\b/.test(command) && /(>+|tee\b|sed\s+-i|perl\s+-pi|mv\b|cp\b|rm\b)/.test(command);
}

function mutatingBash(command: string): boolean {
	// `2>/dev/null` and friends discard output — not a mutation, so strip them
	// before the redirect check. Interpreters (python/node) are read-only in
	// practice here (JSON parsing in pipelines) and stay allowed.
	// ponytail: heuristic, not a sandbox — the prompt guard is the real contract.
	const c = command.replace(/\d?>>?\s*\/dev\/null/g, "");
	return /(^|[;&|()\s])(rm|mv|cp|touch|mkdir|rmdir|ln|chmod|chown|npm|pnpm|yarn|git\s+(commit|add|reset|checkout|switch|merge|rebase|clean|stash|push|pull|apply|am))\b|>>?|\btee\b/.test(c);
}

function recordChange(changesFile: string, hash: string, files: string[]): void {
	const now = new Date().toISOString().replace("T", " ").slice(0, 16);
	const names = files.map(f => f.split("/").pop()).join(", ");
	const entry = `\n## ${now} · ${hash}\nFiles: ${names}\n`;
	const existing = existsSync(changesFile) ? readFileSync(changesFile, "utf8").trimEnd() : CHANGES_TEMPLATE.trimEnd();
	writeFileSync(changesFile, existing + "\n" + entry, "utf8");
}

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	// Files written during the current agent turn, flushed to git on agent_settled.
	let pendingFiles = new Set<string>();

	// On session start / reload: always drop back to discuss.
	// /mode implement only lasts for the current session.
	pi.on("session_start", (_event, ctx) => {
		const s = ensure(ctx.cwd);
		if (s.mode !== "read-only") writeFileSync(join(s.dir, ".mode"), "read-only\n", "utf8");
		if (ctx.hasUI && (s.reset || s.mode !== "read-only")) ctx.ui.notify("mode: read-only", "info");
	});

	// Inject branch workspace context (AGENTS.md + workspace.md) into every agent turn.
	// In discuss mode, append a guard that blocks the agent from making code changes.
	pi.on("before_agent_start", (event, ctx) => {
		const s = ensure(ctx.cwd);
		const agentsMd = existsSync(join(ctx.cwd, "AGENTS.md")) ? join(ctx.cwd, "AGENTS.md") : join(ctx.cwd, ".pi", "agents.md");
		const guard = s.mode === "read-only"
			? `\n\nMODE GUARD: mode is read-only. Investigate before you answer: read the actual files, trace the real flow, verify your assumptions with read/grep, THEN respond. Never propose a change and discover the problem afterwards. If something is still ambiguous after reading, ask instead of guessing. No code changes, installs, commits, or mutations to project files. You MAY write to workspace.md (${s.wsFile}) to capture notes.`
			: "";
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Per-Branch Workspace\nBranch: ${branch(ctx.cwd)}\nWorkspace: ${s.dir}\nCurrent mode: ${s.mode}${guard}\n\n### ${agentsMd.endsWith("AGENTS.md") ? "AGENTS.md" : ".pi/agents.md"}\n${read(agentsMd)}\n\n### workspace.md\n${read(s.wsFile)}`,
		};
	});

	// Gate tool calls based on current mode.
	// .mode file is always read-only via tools — use /mode to change it.
	pi.on("tool_call", (event, ctx) => {
		const s = ensure(ctx.cwd);
		const input = event.input as { path?: string; command?: string };

		// Always block direct .mode manipulation
		if ((event.toolName === "write" || event.toolName === "edit") && isModeFile(ctx.cwd, input.path))
			return { block: true, reason: "Use /mode discuss|implement to change .mode." };
		if (event.toolName === "bash" && input.command && writesModeViaBash(input.command))
			return { block: true, reason: "Use /mode discuss|implement to change .mode." };

		if (s.mode !== "read-only") return;

		// read-only mode: only workspace.md writes are allowed
		if (event.toolName === "write" || event.toolName === "edit") {
			if (isWorkspaceFile(ctx.cwd, input.path)) return;
			return { block: true, terminate: true, reason: "Blocked: in read-only mode, file writes are limited to workspace.md." };
		}
		if (event.toolName === "bash" && input.command && mutatingBash(input.command))
			return { block: true, terminate: true, reason: "Blocked mutating bash: read-only mode." };
	});

	// Collect files written/edited during the turn for auto-commit.
	pi.on("tool_result", (event, _ctx) => {
		if (event.isError) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const input = event.input as { path?: string };
		if (input.path) pendingFiles.add(input.path);
	});

	// Auto-commit all files written during the turn once the agent settles.
	pi.on("agent_settled", (_event, ctx) => {
		if (pendingFiles.size === 0) return;
		const files = [...pendingFiles];
		pendingFiles = new Set();
		const s = ensure(ctx.cwd);
		try {
			execSync(`git add ${files.map(f => `"${f}"`).join(" ")}`, { cwd: ctx.cwd, stdio: "ignore" });
			const names = files.map(f => f.split("/").pop()).join(", ");
			execSync(`git commit -m "feat: ${names}"`, { cwd: ctx.cwd, stdio: "ignore" });
			const hash = execSync("git rev-parse --short HEAD", { cwd: ctx.cwd, encoding: "utf8" }).trim();
			recordChange(s.changesFile, hash, files);
			if (ctx.hasUI) ctx.ui.notify(`committed ${hash} · ${files.length} file(s)`, "info");
		} catch { /* not a git repo or nothing new to commit */ }
	});

	// =============================================================================
	// Commands
	// =============================================================================

	pi.registerCommand("mode", {
		description: "Show or set workspace mode: read-only, edit",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const s = ensure(ctx.cwd);
			const next = args.trim().split(/\s+/)[0];
			if (!next) {
				if (!ctx.hasUI) { ctx.ui.notify(`mode: ${s.mode}`, "info"); return; }
				const choice = await ctx.ui.select(`Current mode: ${s.mode}`, [...MODES]);
				if (!choice) return;
				writeFileSync(join(s.dir, ".mode"), `${choice}\n`, "utf8");
				ctx.ui.notify(`mode: ${choice}`, "info");
				return;
			}
			if (!(MODES as readonly string[]).includes(next)) {
				ctx.ui.notify("mode must be: read-only, edit", "error");
				return;
			}
			writeFileSync(join(s.dir, ".mode"), `${next}\n`, "utf8");
			ctx.ui.notify(`mode: ${next}`, "info");
		},
	});

	pi.registerCommand("ws", {
		description: "Update workspace.md. /ws [section] to target a section, /ws to pick from menu.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const s = ensure(ctx.cwd);
			const parts = args.trim().split(/\s+/);
			let section = parts[0]?.toLowerCase() ?? "";
			const extra = parts.slice(1).join(" ").trim();

			// No args → show selector
			if (!section) {
				const headers = parseHeaders(s.wsFile);
				const SEP = "─────";
				const options = [...headers, SEP, "refine", "commit", "new section..."];
				const choice = await ctx.ui.select("Update workspace section:", options);
				if (!choice || choice === SEP) return;

				if (choice === "new section...") {
					const name = await ctx.ui.input("Section name:", "");
					if (!name?.trim()) return;
					section = name.trim().toLowerCase();
				} else {
					section = choice.toLowerCase();
				}
			}

			await ctx.waitForIdle();

			let prompt: string;
			if (section === "commit") {
				prompt = `Commit all uncommitted changes in this repo with bash: \`git add -A\` then \`git commit -m "wip: <summary>"\` where <summary> is your own one-line summary of what changed (run \`git status\` and \`git diff\` first to write it). Nothing else.${extra ? ` Context: ${extra}.` : ""}`;
			} else if (section === "refine") {
				prompt = `Refine the writing in workspace.md (${s.wsFile}) — fix grammar, improve clarity and conciseness. Do not change meaning or content. Preserve all # H1 headers exactly as-is.`;
			} else {
				const label = section.charAt(0).toUpperCase() + section.slice(1);
				const exists = parseHeaders(s.wsFile).some(h => h.toLowerCase() === section);
				const hint = extra ? ` Focus on this in particular: ${extra}.` : "";
				prompt = exists
					? `Based on our conversation, update the **# ${label}** section in workspace.md (${s.wsFile}). Keep other sections untouched. High-level and concise.${hint}`
					: `Append a new **# ${label}** section at the end of workspace.md (${s.wsFile}) based on our conversation. High-level and concise.${hint}`;
			}

			pi.sendUserMessage(prompt);
		},
	});
}
