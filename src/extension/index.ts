import { readConfig } from "../persistence/goal-persistence";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { GoalManager, GOAL_TOOLS } from "../goal/goal-manager";
import { applyStatusLine } from "../presentation/status-line";
import { formatPausedGoalPrompt } from "../presentation/goal-presenter";
import { registerGoalTools } from "../tools/register-goal-tools";
import { registerGoalCommand } from "../commands/register-goal-command";
import { GoalRuntime } from "../runtime/goal-runtime";
function syncGoalActiveTools(pi: ExtensionAPI, gm: GoalManager): void {
    const baseNames = new Set(pi.getAllTools().map((t) => t.name));
    const goalExists = gm.goal !== null;
    const nextActiveNames = new Set<string>();
    for (const name of baseNames) {
        if (!GOAL_TOOLS.has(name))
            nextActiveNames.add(name);
    }
    if (goalExists) {
        for (const name of GOAL_TOOLS)
            nextActiveNames.add(name);
    }
    const currentActiveNames = new Set(pi.getActiveTools().map((t) => t.name));
    const changed = currentActiveNames.size !== nextActiveNames.size ||
        Array.from(currentActiveNames).some((name) => !nextActiveNames.has(name));
    if (changed)
        pi.setActiveTools(Array.from(nextActiveNames));
}
export default function (pi: ExtensionAPI): void {
    const gm = new GoalManager();
    const runtime = new GoalRuntime(pi, gm);
    const onGoalStateChange = () => syncGoalActiveTools(pi, gm);
    registerGoalTools(pi, gm, runtime, onGoalStateChange);
    registerGoalCommand(pi, gm, runtime, onGoalStateChange);
    pi.on("session_start", (_event, ctx: ExtensionContext) => {
        const branch = ctx.sessionManager.getBranch();
        gm.rebuildFromEntries(branch);
        gm.applyConfig(readConfig());
        syncGoalActiveTools(pi, gm);
        applyStatusLine(ctx, gm);
        if (gm.goal?.status === "paused") {
            const goal = gm.goal;
            const msg = formatPausedGoalPrompt(goal);
            pi.sendMessage({
                customType: "goal-resume-prompt",
                content: msg,
                display: true,
                details: {},
            }, { triggerTurn: false });
            if (ctx.hasUI) {
                ctx.ui.notify(`Paused goal found. Use /goal resume or /goal clear.`, "info");
            }
        }
    });
    pi.on("agent_start", () => {
        runtime.onAgentStart();
    });
    pi.on("turn_start", () => {
        runtime.onTurnStart();
    });
    pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext) => {
        runtime.onTurnEnd(event, ctx);
    });
    pi.on("agent_end", (event, ctx: ExtensionContext) => {
        runtime.onAgentEnd(event, ctx);
    });
    pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
        runtime.onSessionShutdown(ctx);
    });
}
