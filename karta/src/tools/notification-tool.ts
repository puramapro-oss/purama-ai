import { notify } from "../engine/notify.js";
import type { ToolDefinition } from "../engine/types.js";
import { defineTool, enumSchema, objectSchema, optionalSchema, stringSchema } from "./validation.js";

export const sendNotificationTool: ToolDefinition<{ title: string; body: string; priority?: "low" | "normal" | "high" | "urgent" }, { sent: true }> = defineTool({
  name: "send_notification",
  description: "Notifie l'utilisateur (in-app + email) — pour l'informer d'une échéance, alerte ou action requise.",
  sensitive: false,
  input: objectSchema({
    title: stringSchema({ maxLength: 512, pattern: "\\S" }),
    body: stringSchema({ maxLength: 20_000, pattern: "\\S" }),
    priority: optionalSchema(enumSchema(["low", "normal", "high", "urgent"])),
  }),
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
});
