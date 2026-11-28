import { notify, notifyWithReceipt, type NotifyInput } from "../engine/notify.js";
import type { ToolDefinition } from "../engine/types.js";

export const sendNotificationTool: ToolDefinition<{ title: string; body: string; priority?: "low" | "normal" | "high" | "urgent" }, { sent: true; notificationId?: string }> = {
  name: "send_notification",
  description: "Notifie l'utilisateur (in-app + email) — pour l'informer d'une échéance, alerte ou action requise.",
  sensitive: false,
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 300 },
      body: { type: "string", minLength: 1, maxLength: 5000 },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
    },
    required: ["title", "body"],
    additionalProperties: false,
  },
  async execute(params, ctx) {
    const notification: NotifyInput = {
      userId: ctx.userId,
      agentType: ctx.agentType,
      title: params.title,
      body: params.body,
      priority: params.priority ?? "normal",
      channels: ["in_app", "email"],
    };
    if (ctx.gmailInboxBinding) return { sent: true, notificationId: await notifyWithReceipt(notification) };
    await notify(notification);
    return { sent: true };
  },
};
