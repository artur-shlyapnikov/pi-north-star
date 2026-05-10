import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { GOAL_EVENT_CUSTOM_TYPE, SNAPSHOT_CUSTOM_TYPE, type GoalChangeReason, type GoalConfig, type GoalPauseReason, type GoalSnapshot, } from "../goal/goal-types";
const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG_PATH = join(EXTENSION_DIR, "config.json");
const DEFAULT_CONFIG: GoalConfig = {
    planFileEnabled: true,
    verifierPolicy: "off",
};
export function readConfig(): GoalConfig {
    try {
        if (!existsSync(CONFIG_PATH))
            return { ...DEFAULT_CONFIG };
        const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
        return {
            planFileEnabled: typeof raw.planFileEnabled === "boolean" ? raw.planFileEnabled : DEFAULT_CONFIG.planFileEnabled,
            verifierPolicy: ["off", "warn", "enforce"].includes(raw.verifierPolicy) ? raw.verifierPolicy : DEFAULT_CONFIG.verifierPolicy,
        };
    }
    catch {
        return { ...DEFAULT_CONFIG };
    }
}
export function writeConfig(partial: Partial<GoalConfig>): void {
    try {
        const existing = existsSync(CONFIG_PATH)
            ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
            : {};
        const merged = { ...existing, ...partial };
        const dir = dirname(CONFIG_PATH);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    }
    catch (err) {
        console.error("[goal] failed to write config", err);
    }
}
function toGoalSnapshot(value: Record<string, unknown>): GoalSnapshot | null {
    if (value.schemaVersion !== 1)
        return null;
    if (typeof value.id !== "string")
        return null;
    if (typeof value.objective !== "string")
        return null;
    if (!(value.status === "active" || value.status === "paused" || value.status === "complete" || value.status === "budget_limited"))
        return null;
    if (typeof value.tokensUsed !== "number")
        return null;
    if (typeof value.timeUsedSeconds !== "number")
        return null;
    if (typeof value.createdAt !== "string")
        return null;
    if (typeof value.updatedAt !== "string")
        return null;
    if (typeof value.continuationSequence !== "number")
        return null;
    const revision = typeof value.revision === "number" ? value.revision : 1;
    const pauseReason = (value.pauseReason === "user" || value.pauseReason === "abort" || value.pauseReason === "no_progress" || value.pauseReason === "error" || value.pauseReason === "session_replaced") ? value.pauseReason as GoalPauseReason : undefined;
    const tokenBudget = typeof value.tokenBudget === "number" ? value.tokenBudget : undefined;
    const completedAt = typeof value.completedAt === "string" ? value.completedAt : undefined;
    return {
        schemaVersion: 1,
        id: value.id,
        revision,
        objective: value.objective,
        status: value.status as GoalSnapshot["status"],
        pauseReason,
        tokenBudget,
        tokensUsed: value.tokensUsed,
        timeUsedSeconds: value.timeUsedSeconds,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        completedAt,
        continuationSequence: value.continuationSequence,
    };
}
function isSnapshotWrapper(value: unknown): value is {
    reason: string;
    goal: Record<string, unknown> | null;
} {
    if (!(typeof value === "object" && value !== null))
        return false;
    if (!("reason" in value) || typeof value.reason !== "string")
        return false;
    if (!("goal" in value))
        return false;
    const goal = value.goal;
    if (goal === null)
        return true;
    return typeof goal === "object" && goal !== null && "schemaVersion" in goal;
}
export function loadGoalFromBranch(ctx: ExtensionContext): GoalSnapshot | null {
    const branch = ctx.sessionManager.getBranch();
    return loadGoalFromEntries(branch);
}
export function emitGoalEvent(pi: ExtensionAPI, goal: GoalSnapshot | null, reason: GoalChangeReason): void {
    if (reason === "usage")
        return;
    pi.sendMessage({
        customType: GOAL_EVENT_CUSTOM_TYPE,
        content: JSON.stringify({
            goal,
            reason,
            timestamp: new Date().toISOString(),
        }),
        display: false,
        details: {},
    }, { triggerTurn: false });
}
export function loadGoalFromEntries(entries: SessionEntry[]): GoalSnapshot | null {
    let last: GoalSnapshot | null = null;
    for (const entry of entries) {
        if (entry.type !== "custom" || !("customType" in entry) || entry.customType !== SNAPSHOT_CUSTOM_TYPE)
            continue;
        const wrapper = "data" in entry ? (entry as {
            data?: unknown;
        }).data : undefined;
        if (!isSnapshotWrapper(wrapper))
            continue;
        if (wrapper.goal === null) {
            last = null;
        }
        else if (wrapper.goal && typeof wrapper.goal === "object" && "schemaVersion" in wrapper.goal) {
            const normalized = toGoalSnapshot(wrapper.goal as Record<string, unknown>);
            if (normalized !== null)
                last = normalized;
        }
    }
    return last;
}
export function persistGoal(pi: ExtensionAPI, goal: GoalSnapshot | null, reason: GoalChangeReason): void {
    if (goal !== null && !(typeof goal === "object" && goal !== null && typeof goal.revision === "number")) {
        throw new Error("persistGoal: goal snapshot must have a revision");
    }
    pi.appendEntry(SNAPSHOT_CUSTOM_TYPE, { reason, goal });
    emitGoalEvent(pi, goal, reason);
}
