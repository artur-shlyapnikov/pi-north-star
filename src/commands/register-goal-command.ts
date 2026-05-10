import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GoalManager } from "../goal/goal-manager";
import type { GoalRuntime } from "../runtime/goal-runtime";
import { GoalService, type GoalServiceResult } from "../goal/goal-service";
import { formatGoalSummary } from "../presentation/goal-presenter";
import { parseGoalCommand, type ParsedGoalCommand } from "./command-parser";
export function registerGoalCommand(pi: ExtensionAPI, gm: GoalManager, runtime: GoalRuntime, onSyncGoalTools?: () => void): void {
    const service = new GoalService({ pi, gm, runtime, onSyncGoalTools });
    async function showGoalStatus(ctx: ExtensionCommandContext): Promise<void> {
        if (!gm.goal) {
            const msg = "No active goal. Use /goal <objective> to create one.";
            pi.sendMessage({
                customType: "goal-status",
                content: msg,
                display: true,
                details: {},
            }, { triggerTurn: false });
            if (ctx.hasUI)
                ctx.ui.notify(msg, "info");
            return;
        }
        const summary = formatGoalSummary(gm.goal);
        pi.sendMessage({
            customType: "goal-status",
            content: summary,
            display: true,
            details: {},
        }, { triggerTurn: false });
        if (ctx.hasUI)
            ctx.ui.notify(summary, "info");
    }
    pi.registerCommand("goal", {
        description: "Manage goals. Usage: /goal <text> | /goal pause|resume|clear|replace|budget|verify|plan-file",
        getArgumentCompletions: (prefix: string) => {
            const cmds = ["pause", "resume", "clear", "replace", "budget", "verify", "plan-file"];
            const filtered = cmds.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
            return filtered.length > 0 ? filtered : null;
        },
        handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
            const action = parseGoalCommand(args);
            switch (action.kind) {
                case "syntax-error":
                    emitAndNotify(pi, ctx, `Usage: ${action.usage}`, "error");
                    return;
                case "show":
                    await showGoalStatus(ctx);
                    return;
                case "pause":
                    emitServiceResult(pi, ctx, await service.pause({ ctx }));
                    return;
                case "resume":
                    await emitValidated(pi, ctx, service.resume({ budget: action.budget, ctx }), "/goal resume [--budget <positive-integer>]");
                    return;
                case "clear":
                    emitServiceResult(pi, ctx, await service.clear({ ctx }));
                    return;
                case "replace":
                    await emitValidated(pi, ctx, service.createOrReplace({ objective: action.objective, budget: action.budget, ctx }, "replaced"), "/goal replace [--budget <positive-integer>] <objective>", { summarizeGoal: true });
                    return;
                case "budget":
                    await emitValidated(pi, ctx, service.updateBudget({ budget: action.budget, ctx }), "/goal budget <positive-integer>|none");
                    return;
                case "verify-show":
                    emitServiceResult(pi, ctx, { ok: true, level: "info", message: `Verifier policy: ${gm.verifierPolicy}` });
                    return;
                case "verify-set":
                    emitServiceResult(pi, ctx, service.setVerifierPolicy(action.policyRaw));
                    return;
                case "plan-file-show":
                    emitServiceResult(pi, ctx, service.showPlanFileEnabled());
                    return;
                case "plan-file-set":
                    emitServiceResult(pi, ctx, service.setPlanFileEnabled(action.enabled));
                    return;
                case "create":
                    await emitValidated(pi, ctx, service.create({ objective: action.objective, budget: action.budget, ctx }), "/goal [--budget <positive-integer>] <objective>", { summarizeGoal: true });
                    return;
            }
        },
    });
}
async function emitValidated(pi: ExtensionAPI, ctx: ExtensionCommandContext, promise: Promise<GoalServiceResult>, usage: string, options?: {
    summarizeGoal?: boolean;
}): Promise<void> {
    const result = withUsageOnValidationError(await promise, usage);
    if (options?.summarizeGoal) {
        emitGoalSummaryOrServiceResult(pi, ctx, result);
    }
    else {
        emitServiceResult(pi, ctx, result);
    }
}
function emitGoalSummaryOrServiceResult(pi: ExtensionAPI, ctx: ExtensionCommandContext, result: GoalServiceResult): void {
    if (result.ok && result.goal) {
        emitAndNotify(pi, ctx, formatGoalSummary(result.goal), "info");
        return;
    }
    emitServiceResult(pi, ctx, result);
}
function withUsageOnValidationError(result: GoalServiceResult, usage: string): GoalServiceResult {
    if (!result.ok && result.code === "validation") {
        return {
            ...result,
            level: "error",
            message: `Usage: ${usage} (${result.error})`,
        };
    }
    return result;
}
function emitServiceResult(pi: ExtensionAPI, ctx: ExtensionCommandContext, result: GoalServiceResult): void {
    const message = result.message ?? result.error;
    if (!message)
        return;
    emitAndNotify(pi, ctx, message, result.level);
}
function emitAndNotify(pi: ExtensionAPI, ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
    pi.sendMessage({
        customType: "goal-status",
        content: message,
        display: true,
        details: {},
    }, { triggerTurn: false });
    if (ctx.hasUI)
        ctx.ui.notify(message, level);
}
