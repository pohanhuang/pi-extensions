import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { basename, join, resolve } from "node:path";

const MODES = ["plan", "discuss", "implement"] as const;
type Mode = (typeof MODES)[number];

const READ_ONLY_MODES = new Set<Mode>(["plan", "discuss"]);
const BLOCKED_TOOLS = new Set(["write", "edit"]);

const TEMPLATES = {
	agents: "# Agent Instructions\n\n<!-- Shared behavior and constraints for this repository. -->\n",
	plan: "# Plan\n\n<!-- What problem does this branch solve, and what is the plan? -->\n",
	discuss: "# Discussion\n\n<!-- Notes, tradeoffs, and open questions. -->\n",
	implementation: "# Implementation\n\n## Progress\n\nNot started.\n\n## TODO\n\n- Define the implementation after planning.\n",
};

function branch(cwd: string): string {
	try {
		const name = execSync("git symbolic-ref --quiet --short HEAD", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return name || "detached";
	} catch {
		return "main";
	}
}

function workspace(cwd: string): string {
	return join(cwd, ".pi", branch(cwd).replace(/[\\/]/g, "-"));
}

function writeMissing(path: string, content: string, fallback?: string): void {
	if (existsSync(path)) return;
	writeFileSync(path, fallback && existsSync(fallback) ? readFileSync(fallback, "utf8") : content, "utf8");
}

function normalizeMode(value: string): Mode {
	const mode = value.trim();
	return (MODES as readonly string[]).includes(mode) ? (mode as Mode) : "discuss";
}

function ensure(cwd: string): { dir: string; mode: Mode; reset: boolean } {
	const root = join(cwd, ".pi");
	const dir = workspace(cwd);
	mkdirSync(dir, { recursive: true });
	writeMissing(join(root, "agents.md"), TEMPLATES.agents);
	writeMissing(join(dir, "plan.md"), TEMPLATES.plan, join(dir, "context.md"));
	writeMissing(join(dir, "discuss.md"), TEMPLATES.discuss);
	writeMissing(join(dir, "implementation.md"), TEMPLATES.implementation, join(dir, "implement.md"));

	const modePath = join(dir, ".mode");
	let reset = false;
	if (!existsSync(modePath)) writeFileSync(modePath, "discuss\n", "utf8");
	const raw = readFileSync(modePath, "utf8");
	const mode = normalizeMode(raw);
	if (mode !== raw.trim()) {
		writeFileSync(modePath, "discuss\n", "utf8");
		reset = true;
	}
	return { dir, mode, reset };
}

function read(path: string): string {
	return readFileSync(path, "utf8").trimEnd();
}

function modeFile(cwd: string, path: string | undefined): boolean {
	if (!path) return false;
	const full = resolve(cwd, path);
	return basename(full) === ".mode" && full.startsWith(resolve(cwd, ".pi") + "/");
}

function writesMode(command: string): boolean {
	return /\.mode\b/.test(command) && /(>+|tee\b|sed\s+-i|perl\s+-pi|mv\b|cp\b|rm\b)/.test(command);
}

function mutatingBash(command: string): boolean {
	return /(^|[;&|()\s])(rm|mv|cp|touch|mkdir|rmdir|ln|chmod|chown|python|python3|node|npm|pnpm|yarn|git\s+(commit|add|reset|checkout|switch|merge|rebase|clean|stash|push|pull|apply|am))\b|>>?|\btee\b/.test(command);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const s = ensure(ctx.cwd);
		if (s.reset && ctx.hasUI) ctx.ui.notify("Invalid .mode reset to discuss", "warning");
	});

	pi.on("before_agent_start", (event, ctx) => {
		const s = ensure(ctx.cwd);
		const agents = existsSync(join(ctx.cwd, "AGENTS.md")) ? join(ctx.cwd, "AGENTS.md") : join(ctx.cwd, ".pi", "agents.md");
		const docs = s.mode === "discuss"
			? ["plan.md", "discuss.md"]
			: s.mode === "implement"
				? ["plan.md", "implementation.md"]
				: ["plan.md"];
		const guard = READ_ONLY_MODES.has(s.mode)
			? `\n\nMODE GUARD: Current branch workspace mode is ${s.mode}. Do not implement: no file writes, edits, code changes, installs, commits, or mutating shell commands. Inspect, discuss, and plan only.`
			: "";
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Per-Branch Workspace\nBranch: ${branch(ctx.cwd)}\nWorkspace: ${s.dir}\nCurrent mode: ${s.mode}${guard}\n\n### ${agents === join(ctx.cwd, "AGENTS.md") ? "AGENTS.md" : ".pi/agents.md"}\n${read(agents)}\n\n${docs.map((doc) => `### ${doc}\n${read(join(s.dir, doc))}`).join("\n\n")}`,
		};
	});

	pi.on("tool_call", (event, ctx) => {
		const s = ensure(ctx.cwd);
		const input = event.input as { path?: string; command?: string };
		if ((event.toolName === "write" || event.toolName === "edit") && modeFile(ctx.cwd, input.path)) {
			return { block: true, reason: "Use /mode plan|discuss|implement to change .mode." };
		}
		if (event.toolName === "bash" && input.command && writesMode(input.command)) {
			return { block: true, reason: "Use /mode plan|discuss|implement to change .mode." };
		}

		if (!READ_ONLY_MODES.has(s.mode)) return;
		if (BLOCKED_TOOLS.has(event.toolName)) {
			return { block: true, terminate: true, reason: `Blocked: no implementation in ${s.mode} mode.` };
		}
		if (event.toolName === "bash" && input.command && mutatingBash(input.command)) {
			return { block: true, terminate: true, reason: `Blocked mutating bash: no implementation in ${s.mode} mode.` };
		}
	});

	pi.registerCommand("mode", {
		description: "Show or set branch workspace mode: plan, discuss, implement",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const s = ensure(ctx.cwd);
			const next = args.trim().split(/\s+/)[0];
			if (!next) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`mode: ${s.mode}`, "info");
					return;
				}
				const choice = await ctx.ui.select(`Current mode: ${s.mode}. Choose mode:`, [...MODES]);
				if (!choice) return;
				writeFileSync(join(s.dir, ".mode"), `${choice}\n`, "utf8");
				ctx.ui.notify(`mode: ${choice}`, "info");
				return;
			}
			if (!(MODES as readonly string[]).includes(next)) {
				ctx.ui.notify("mode must be: plan, discuss, implement", "error");
				return;
			}
			writeFileSync(join(s.dir, ".mode"), `${next}\n`, "utf8");
			ctx.ui.notify(`mode: ${next}`, "info");
		},
	});
}
