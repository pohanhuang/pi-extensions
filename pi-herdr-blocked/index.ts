/**
 * pi-herdr-blocked
 *
 * Bridges Pi 0.84.4+ ui_prompt_start/end events → herdr:blocked.
 * Fires when ctx.ui.select / confirm / input / editor / custom opens.
 * Plain-text agent replies do NOT trigger this — there is no Pi signal for that.
 */
export default function (pi: any) {
  pi.on("ui_prompt_start", async (_event: any) => {
    pi.events.emit("herdr:blocked", { active: true });
  });

  pi.on("ui_prompt_end", async (_event: any) => {
    pi.events.emit("herdr:blocked", { active: false });
  });
}
