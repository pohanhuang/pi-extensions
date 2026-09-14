import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { basename, join, resolve } from "node:path";

const MODES = ["plan", "discuss", "implement"] as const;
type Mode = (typeof MODES)[number];

const TEMPLATES = {
	agents: "# Agent Instructions\n\n<!-- Shared behavior and constraints for this repository. -->\n",
	context: "# Context\n\n<!-- What problem does this branch solve, and why? -->\n",
	implement: "# Implementation\n\n## Progress\n\nNot started.\n\n## TODO\n\n- Define the implementation after planning.\n",
	discuss: "# Discussion\n\n<!-- Notes, tradeoffs, and open questions. Not loaded by default. -->\n",
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

function writeMissing(path: string, content: string): void {
	if (!existsSync(path)) writeFileSync(path, content, "utf8");
}

function normalizeMode(value: string): Mode {
	const mode = value.trim();
	return (MODES as readonly string[]).includes(mode) ? (mode as Mode) : "plan";
}

function ensure(cwd: string): { dir: string; mode: Mode; reset: boolean } {
	const root = join(cwd, ".pi");
	const dir = workspace(cwd);
	mkdirSync(dir, { recursive: true });
	writeMissing(join(root, "agents.md"), TEMPLATES.agents);
	writeMissing(join(dir, "context.md"), TEMPLATES.context);
	writeMissing(join(dir, "implement.md"), TEMPLATES.implement);
	writeMissing(join(dir, "discuss.md"), TEMPLATES.discuss);

	const modePath = join(dir, ".mode");
	let reset = false;
	if (!existsSync(modePath)) writeFileSync(modePath, "plan\n", "utf8");
	const raw = readFileSync(modePath, "utf8");
	const mode = normalizeMode(raw);
	if (mode !== raw.trim()) {
		writeFileSync(modePath, "plan\n", "utf8");
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

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const s = ensure(ctx.cwd);
		if (s.reset && ctx.hasUI) ctx.ui.notify("Invalid .mode reset to plan", "warning");
	});

	pi.on("before_agent_start", (event, ctx) => {
		const s = ensure(ctx.cwd);
		const agents = join(ctx.cwd, ".pi", "agents.md");
		const context = join(s.dir, "context.md");
		const implement = join(s.dir, "implement.md");
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Per-Branch Workspace\nBranch: ${branch(ctx.cwd)}\nWorkspace: ${s.dir}\nCurrent mode: ${s.mode}\n\n### .pi/agents.md\n${read(agents)}\n\n### context.md\n${read(context)}\n\n### implement.md\n${read(implement)}\n\nDo not load discuss.md unless it is needed.`,
		};
	});

	pi.on("tool_call", (event, ctx) => {
		const input = event.input as { path?: string; command?: string };
		if ((event.toolName === "write" || event.toolName === "edit") && modeFile(ctx.cwd, input.path)) {
			return { block: true, reason: "Use /mode plan|discuss|implement to change .mode." };
		}
		if (event.toolName === "bash" && input.command && writesMode(input.command)) {
			return { block: true, reason: "Use /mode plan|discuss|implement to change .mode." };
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
