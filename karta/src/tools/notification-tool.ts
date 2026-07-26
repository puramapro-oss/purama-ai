import { notify } from "../engine/notify.js";
import type { ToolDefinition } from "../engine/types.js";

export const sendNotificationTool: ToolDefinition<{ title: string; body: string; priority?: "low" | "normal" | "high" | "urgent" }, { sent: true }> = {
  name: "send_notification",
  description: "Notifie l'utilisateur (in-app + email) — pour l'informer d'une échéance, alerte ou action requise.",
  sensitive: false,
  async execute(params, ctx) {
    await notify({
      userId: ctx.userId,
      agentType: ctx.agentType,
      title: params.title,
      body: params.body,
      priority: params.priority ?? "normal",
      channels: ["in_app", "email"],
    });
    return { sent: true };
  },
};
