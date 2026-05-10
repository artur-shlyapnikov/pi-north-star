import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalManager } from "../goal/goal-manager";
const STATUS_KEY = "goal";
const WIDGET_KEY = "goal-card";
function truncate(text: string, max: number): string {
    if (text.length <= max)
        return text;
    return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
export function formatTokensShort(count: number): string {
    if (count < 1000)
        return `${count}`;
    if (count < 10000)
        return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000)
        return `${Math.round(count / 1000)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
}
export function formatDuration(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0)
        return `${h}h ${m}m ${s}s`;
    if (m > 0)
        return `${m}m ${s}s`;
    return `${s}s`;
}
function formatGoalStatusText(gm: GoalManager): string | undefined {
    if (!gm.goal || gm.goal.status !== "active")
        return undefined;
    const g = gm.goal;
    const phase = gm.livePhase ?? "active";
    if (g.tokenBudget !== undefined)
        return `goal: ${phase} ${g.tokensUsed}/${g.tokenBudget}`;
    return `goal: ${phase}`;
}
function renderGoalWidgetLines(gm: GoalManager): string[] | undefined {
    if (!gm.goal || gm.goal.status !== "active")
        return undefined;
    const g = gm.goal;
    const line1 = `Goal: ${truncate(g.objective.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim(), 160)}`;
    const budget = g.tokenBudget !== undefined
        ? `${formatTokensShort(g.tokensUsed)}/${formatTokensShort(g.tokenBudget)}`
        : `${formatTokensShort(g.tokensUsed)}/∞`;
    const line2 = `tokens ${budget} • time ${formatDuration(g.timeUsedSeconds)}`;
    return [line1, line2];
}
export function applyStatusLine(ctx: ExtensionContext, gm: GoalManager): void {
    const text = formatGoalStatusText(gm);
    if (ctx.ui) {
        if (text)
            ctx.ui.setStatus(STATUS_KEY, text);
        else
            ctx.ui.setStatus(STATUS_KEY, undefined);
    }
    if (!ctx.hasUI || !ctx.ui)
        return;
    const widget = renderGoalWidgetLines(gm);
    if (widget) {
        ctx.ui.setWidget(WIDGET_KEY, widget, { placement: "belowEditor" });
    }
    else {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
}
