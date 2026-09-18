/**
 * pi-herdr-blocked
 *
 * Bridges Pi's native ui_prompt_start / ui_prompt_end events to herdr:blocked,
 * so herdr shows "blocked" (not "working") when Pi is waiting for user input.
 *
 * Works with the herdr-agent-state.ts integration (v9+) which already
 * consumes herdr:blocked — this extension just fills the missing signal.
 *
 * Pi ──ui_prompt_start──► pi.events.emit("herdr:blocked", { active: true })
 *                                   ↓
 *                         herdr-agent-state.ts → pane.report_agent blocked
 *
 * Pi ──ui_prompt_end────► pi.events.emit("herdr:blocked", { active: false })
 *                                   ↓
 *                         herdr-agent-state.ts → pane.report_agent working/idle
 */
export default function (pi: any) {
  // UI overlay (ctx.ui.input / permission-system) → blocked
  pi.on("ui_prompt_start", async (_event: any) => {
    pi.events.emit("herdr:blocked", { active: true });
  });

  pi.on("ui_prompt_end", async (_event: any) => {
    pi.events.emit("herdr:blocked", { active: false });
  });

  // Agent replied in plain text and is waiting for user → also blocked
  pi.on("agent_settled", async (_event: any) => {
    console.error("[pi-herdr-blocked] agent_settled fired");
    pi.events.emit("herdr:blocked", { active: true });
    console.error("[pi-herdr-blocked] emitted herdr:blocked active=true");
  });

  // User sent a message, agent starts working → unblock
  pi.on("agent_start", async (_event: any) => {
    console.error("[pi-herdr-blocked] agent_start fired");
    pi.events.emit("herdr:blocked", { active: false });
  });
}
