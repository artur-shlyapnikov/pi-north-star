import type { AgentToolResult, ExtensionAPI, ExtensionContext, } from "@earendil-works/pi-coding-agent";
import { Static, Type } from "typebox";
import { type GoalManager } from "../goal/goal-manager";
import type { CompletionBudgetReport, GoalServiceResult, GoalSnapshot, ToolTextContent, } from "../goal/goal-types";
import type { GoalRuntime } from "../runtime/goal-runtime";
import { GoalService } from "../goal/goal-service";
interface ToolSuccessPayload {
    goal?: GoalSnapshot | null;
    remainingTokens?: number | null;
    completionBudgetReport?: CompletionBudgetReport | null;
    message?: string;
}
interface ToolResult extends AgentToolResult<ToolTextContent> {
    content: ToolTextContent[];
    details: Record<string, unknown>;
}
const updateGoalParamsSchema = Type.Object({
    status: Type.String({ description: "Only value: 'complete'" }),
});
type UpdateGoalParams = Static<typeof updateGoalParamsSchema>;
const clearGoalParamsSchema = Type.Object({});
function goalPayload(goal: GoalSnapshot | null): ToolSuccessPayload {
    if (!goal)
        return { goal: null };
    const remaining = goal.tokenBudget !== undefined
        ? Math.max(0, goal.tokenBudget - goal.tokensUsed)
        : null;
    return { goal, remainingTokens: remaining, completionBudgetReport: null };
}
function toolResponseFromService(result: GoalServiceResult): ToolResult {
    if (!result.ok) {
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        error: result.error ?? result.message ?? "Unknown goal service error.",
                        ...(result.verifierResult ? { verifierResult: result.verifierResult } : {}),
                    }, null, 2),
                }],
            isError: true,
            details: {},
        };
    }
    const payload: ToolSuccessPayload = {};
    if (result.goal !== undefined)
        payload.goal = result.goal;
    if (result.remainingTokens !== undefined)
        payload.remainingTokens = result.remainingTokens;
    if (result.completionBudgetReport !== undefined)
        payload.completionBudgetReport = result.completionBudgetReport;
    if (result.message !== undefined)
        payload.message = result.message;
    return {
        content: [{
                type: "text",
                text: JSON.stringify(payload, null, 2),
            }],
        ...(result.terminate === true ? { terminate: true } : {}),
        details: {},
    };
}
export function registerGoalTools(pi: ExtensionAPI, gm: GoalManager, runtime: GoalRuntime, onSyncGoalTools?: () => void): void {
    const service = new GoalService({ pi, gm, runtime, onSyncGoalTools });
    pi.registerTool({
        name: "get_goal",
        label: "Get Goal",
        description: "Get the current goal for this thread, including status and budgets.",
        promptSnippet: "Get the current goal objective, status, and budget info",
        promptGuidelines: [
            "Use get_goal to check the current goal when you need to know what to work toward.",
        ],
        parameters: Type.Object({}),
        executionMode: "sequential",
        async execute() {
            return {
                content: [{ type: "text", text: JSON.stringify(goalPayload(gm.goal), null, 2) }],
                details: {},
            };
        },
    });
    pi.registerTool({
        name: "update_goal",
        label: "Update Goal",
        description: "Mark the current goal as complete.",
        promptSnippet: "Mark the current goal as complete when all objective criteria are satisfied",
        promptGuidelines: [
            "Use update_goal(status=\"complete\") ONLY when ALL objective criteria are verified with concrete evidence.",
            "Do NOT call update_goal if criteria are only partially met or unverified.",
            "Do not self-complete a goal unless you are confident the user would agree the objective is genuinely achieved. Premature completion that merely checks a box but doesn't satisfy the user's intent undermines trust. When in doubt, continue working or ask the user.",
        ],
        parameters: updateGoalParamsSchema,
        executionMode: "sequential",
        async execute(_toolCallId: string, params: UpdateGoalParams, _signal?: AbortSignal, _ctx?: ExtensionContext) {
            if (params.status !== "complete") {
                return {
                    content: [{ type: "text", text: JSON.stringify({ error: 'Only status="complete" is supported.' }) }],
                    isError: true,
                    details: {},
                };
            }
            const safeCtx = _ctx?.ui ? _ctx : undefined;
            const result = await service.complete({ ctx: safeCtx });
            return toolResponseFromService(result);
        },
    });
    pi.registerTool({
        name: "clear_goal",
        label: "Clear Goal",
        description: "Clear the current goal. Use when the user wants to cancel or abandon the current goal.",
        promptSnippet: undefined,
        promptGuidelines: [],
        parameters: clearGoalParamsSchema,
        executionMode: "sequential",
        async execute(_toolCallId: string, _params: Static<typeof clearGoalParamsSchema>, _signal?: AbortSignal, _ctx?: ExtensionContext) {
            const safeCtx = _ctx?.ui ? _ctx : undefined;
            const result = await service.clear({ ctx: safeCtx });
            if (!result.ok && result.error === "No goal to clear.") {
                return {
                    content: [{ type: "text", text: JSON.stringify({ error: "No active goal to clear." }, null, 2) }],
                    isError: true,
                    details: {},
                };
            }
            return toolResponseFromService(result);
        },
    });
}
