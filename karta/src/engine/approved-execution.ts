import type { ToolDefinition, ToolExecutionContext } from "./types.js";

// This capability stays in the dispatcher process. Request fields and copied contexts cannot convey it.
const approvals = new WeakMap<ToolExecutionContext, string>();

export async function executeClaimedTool<P, R>(tool: ToolDefinition<P, R>, params: P, context: ToolExecutionContext & { operationId: string }): Promise<R> {
  if (!tool.requiresExplicitApproval) return tool.execute(params, context);
  if (context.mode !== "live" || !context.operationId) throw new Error("Approbation explicite invalide");
  approvals.set(context, context.operationId);
  try {
    return await tool.execute(params, context);
  } finally {
    approvals.delete(context);
  }
}

export function consumeClaimedApproval(context: ToolExecutionContext): boolean {
  const claimed = approvals.get(context);
  if (!claimed) return false;
  approvals.delete(context);
  return context.mode === "live" && context.operationId === claimed;
}
