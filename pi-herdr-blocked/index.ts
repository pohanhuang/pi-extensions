/**
 * pi-herdr-blocked
 *
 * Maps Pi events to herdr:blocked on the shared event bus.
 *
 * 1. UI overlay (ctx.ui.input / permission-system) → always blocked
 * 2. agent_settled → blocked only if the last assistant message looks like a question
 */
export default function (pi: any) {
  let lastAssistantText = "";

  // Track the last assistant message content
  pi.on("message_end", async (event: any) => {
    if (event.message?.role !== "assistant") return;
    const content = event.message?.content;
    if (typeof content === "string") {
      lastAssistantText = content;
    } else if (Array.isArray(content)) {
      lastAssistantText = content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
    }
  });

  // UI overlay → blocked
  pi.on("ui_prompt_start", async (_event: any) => {
    pi.events.emit("herdr:blocked", { active: true });
  });

  pi.on("ui_prompt_end", async (_event: any) => {
    pi.events.emit("herdr:blocked", { active: false });
  });

  // agent_settled → blocked only if the last reply looks like a question
  pi.on("agent_settled", async (_event: any) => {
    const text = lastAssistantText.trim();
    const looksLikeQuestion = text.endsWith("?") || /\?\s*$/.test(text);
    if (looksLikeQuestion) {
      pi.events.emit("herdr:blocked", { active: true });
    }
  });

  // User sent a message → unblock
  pi.on("agent_start", async (_event: any) => {
    pi.events.emit("herdr:blocked", { active: false });
  });
}
