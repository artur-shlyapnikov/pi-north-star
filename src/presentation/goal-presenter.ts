import type { GoalSnapshot } from "../goal/goal-types";
import { formatDuration, formatTokensShort } from "./status-line";
export function formatGoalSummary(goal: GoalSnapshot): string {
    const lines: string[] = [
        `Goal: ${goal.objective}`,
        `Status: ${goal.status}${goal.pauseReason ? ` (${goal.pauseReason})` : ""}`,
        `Tokens: ${goal.tokensUsed}${goal.tokenBudget !== undefined ? ` / ${goal.tokenBudget}` : ""}`,
        `Time: ${goal.timeUsedSeconds}s`,
        `Sequence: ${goal.continuationSequence}`,
    ];
    return lines.join("\n");
}
export function formatPausedGoalPrompt(goal: GoalSnapshot): string {
    const budgetLine = goal.tokenBudget !== undefined
        ? `Tokens used: ${formatTokensShort(goal.tokensUsed)} / ${formatTokensShort(goal.tokenBudget)}`
        : `Tokens used: ${formatTokensShort(goal.tokensUsed)}`;
    return [
        `A paused goal from a previous session was found.`,
        ``,
        `Objective: ${goal.objective}`,
        `Status: paused`,
        `${budgetLine}`,
        `Time: ${formatDuration(goal.timeUsedSeconds)}`,
        ``,
        `Resume it with:  /goal resume`,
        `Resume with new budget:  /goal resume --budget <N>`,
        `Clear it with:  /goal clear`,
    ].join("\n");
}
