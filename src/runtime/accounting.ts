import type { TokenUsageSnapshot } from "../goal/goal-types";
export function accountTokenDelta(usage: TokenUsageSnapshot): number {
    const nonCachedInput = Math.max(0, usage.input - usage.cachedInput);
    return nonCachedInput + usage.output;
}
export function parseTokenUsage(usage: unknown): TokenUsageSnapshot | null {
    if (!usage || typeof usage !== "object")
        return null;
    const u = usage as Record<string, unknown>;
    const input = typeof u.input === "number" ? u.input : 0;
    const cachedInput = typeof u.cachedInput === "number" ? u.cachedInput
        : typeof u.cacheRead === "number" ? u.cacheRead : 0;
    const output = typeof u.output === "number" ? u.output : 0;
    if (input === 0 && cachedInput === 0 && output === 0)
        return null;
    return { input, cachedInput, output };
}
export function readMessageUsage(message: unknown): unknown {
    if (!message || typeof message !== "object")
        return undefined;
    return "usage" in message ? (message as {
        usage?: unknown;
    }).usage : undefined;
}
export class WallClock {
    lastAccountedAt: number | null = null;
    activeGoalId: string | null = null;
    markActiveGoal(goalId: string): void {
        if (this.activeGoalId !== goalId) {
            this.lastAccountedAt = performance.now();
            this.activeGoalId = goalId;
        }
    }
    clearActiveGoal(): void {
        this.lastAccountedAt = null;
        this.activeGoalId = null;
    }
}
