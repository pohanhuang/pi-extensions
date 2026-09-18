/**
 * pi-herdr-blocker
 *
 * 1. Bridges Pi 0.84.4+ ui_prompt_start/end events → herdr:blocked.
 *    Fires when ctx.ui.select / confirm / input / editor / custom opens.
 * 2. Registers ask_me, a tool the agent can call to block on purpose.
 *
 * Plain-text agent replies do NOT block — there is no Pi signal for that.
 */
import { Type } from "typebox";

export default function (pi: any) {
	pi.on("ui_prompt_start", () => pi.events.emit("herdr:blocked", { active: true }));
	pi.on("ui_prompt_end", () => pi.events.emit("herdr:blocked", { active: false }));

	pi.registerTool({
		name: "ask_me",
		label: "Ask Me",
		description: "Ask the user a question and wait for the answer. Blocks the turn until answered.",
		promptSnippet: "Ask the user a question and block until they answer",
		executionMode: "sequential",
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask" }),
			options: Type.Optional(Type.Array(Type.String(), { description: "Choices to pick from" })),
		}),
		async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			if (!ctx.hasUI) return { content: [{ type: "text", text: "No UI available." }] };
			const answer = params.options?.length
				? await ctx.ui.select(params.question, params.options)
				: await ctx.ui.input(params.question, "");
			return { content: [{ type: "text", text: answer ?? "(cancelled)" }] };
		},
	});
}
