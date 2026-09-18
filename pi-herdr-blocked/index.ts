/**
 * pi-herdr-blocked
 *
 * Maps Pi's idle/prompt states to herdr:blocked on the shared event bus.
 *
 * agent_settled (ctx.isIdle = true)  → herdr:blocked active=true  → herdr shows blocked
 * agent_start                        → herdr:blocked active=false  → herdr shows working
 * ui_prompt_start / ui_prompt_end    → same as above (UI overlay path)
 */
export default function (pi: any) {
  // UI overlay (ctx.ui.input / permission-system) → blocked
  pi.on("ui_prompt_start", async (_event: any) => {
    pi.events.emit("herdr:blocked", { active: true });
  });

  pi.on("ui_prompt_end", async (_event: any) => {
    pi.events.emit("herdr:blocked", { active: false });
  });

  // Pi stopped and is waiting for user → blocked
  pi.on("agent_settled", async (_event: any) => {
    pi.events.emit("herdr:blocked", { active: true });
  });

  // User sent a message, pi is working again → unblock
  pi.on("agent_start", async (_event: any) => {
    pi.events.emit("herdr:blocked", { active: false });
  });
}
