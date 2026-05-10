import { describe, it, expect, beforeEach } from "bun:test";
import { GoalRuntime } from "../../src/runtime/goal-runtime";
import { GoalManager } from "../../src/goal/goal-manager";
import { SNAPSHOT_CUSTOM_TYPE } from "../../src/goal/goal-types";
import type { TurnEndEvent, AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeGoalSnapshot, makeGoalSnapshotEntry, makeRuntimeHarness, drainRuntime, findMessagesByCustomType, makeExtensionContext, makeMockApi, } from "../fixtures/test-fixtures";
import { persistGoal } from "../../src/persistence/goal-persistence";
function makeGoal(id = "test-goal-id", tokenBudget?: number, status: "active" | "paused" | "complete" | "budget_limited" = "active") {
    return makeGoalSnapshot({ id, objective: "test objective", tokenBudget, status });
}
type PrivRuntime = GoalRuntime & {
    waitForLifecycleDrain(): Promise<void>;
    queueLifecycle(task: () => Promise<void> | void): void;
    dispatchContinuation(ctx?: ExtensionContext): Promise<void>;
    agentRunning: boolean;
    continuationTriggerPending: boolean;
    continuationTurnActive: boolean;
    continuationToolCount: number;
    toolCompletedGoalDone: boolean;
    dispatchScheduled: boolean;
    budgetSteeringSentForGoalId: string | null;
    wallClock: {
        lastAccountedAt: number | null;
        activeGoalId: string | null;
        markActiveGoal(id: string): void;
        clearActiveGoal(): void;
    };
    lifecycleTail: Promise<void>;
    maybeSteerBudgetLimit(): void;
    flushTurnTimeOnly(): void;
};
function privRuntime(r: GoalRuntime): PrivRuntime {
    return r as unknown as PrivRuntime;
}
function priv<T>(obj: T): T {
    return obj;
}
function turnEndPayload(overrides?: {
    toolResults?: {
        toolName: string;
        isError?: boolean;
    }[];
    usage?: {
        input: number;
        cachedInput: number;
        output: number;
    };
}): TurnEndEvent {
    const toolResults = overrides?.toolResults ?? [];
    const usage = overrides?.usage ?? { input: 0, cachedInput: 0, output: 0 };
    return { toolResults, message: { usage } } as unknown as TurnEndEvent;
}
function makeCtx(overrides?: Partial<ExtensionContext>): ExtensionContext {
    return makeExtensionContext({
        branchEntries: [],
        hasUI: false,
        aborted: false,
        hasPendingMessages: false,
        idle: true,
        ...overrides as any,
    });
}
function makeCtxWithPersistedGoal(goal: ReturnType<typeof makeGoal>): ExtensionContext {
    return makeExtensionContext({
        branchEntries: [makeGoalSnapshotEntry(goal, "created")],
        hasUI: false,
        idle: true,
    });
}
describe("onAgentStart", () => {
    it("resets continuationTriggerPending to false", () => {
        const { runtime } = makeRuntimeHarness({ goal: makeGoal() });
        privRuntime(runtime).continuationTriggerPending = true;
        runtime.onAgentStart();
        expect(privRuntime(runtime).continuationTriggerPending).toBe(false);
    });
    it("sets continuationTurnActive from pending flag", () => {
        const { runtime } = makeRuntimeHarness({ goal: makeGoal() });
        privRuntime(runtime).continuationTriggerPending = true;
        runtime.onAgentStart();
        expect(privRuntime(runtime).continuationTurnActive).toBe(true);
    });
    it("sets agentRunning to true", () => {
        const { runtime } = makeRuntimeHarness({ goal: makeGoal() });
        runtime.onAgentStart();
        expect(privRuntime(runtime).agentRunning).toBe(true);
    });
    it("resets continuationToolCount to 0", () => {
        const { runtime } = makeRuntimeHarness({ goal: makeGoal() });
        privRuntime(runtime).continuationToolCount = 5;
        runtime.onAgentStart();
        expect(privRuntime(runtime).continuationToolCount).toBe(0);
    });
    it("resets toolCompletedGoalDone to false", () => {
        const { runtime } = makeRuntimeHarness({ goal: makeGoal() });
        privRuntime(runtime).toolCompletedGoalDone = true;
        runtime.onAgentStart();
        expect(privRuntime(runtime).toolCompletedGoalDone).toBe(false);
    });
});
describe("onTurnStart", () => {
    it("syncs wall clock for active goal", () => {
        const { runtime } = makeRuntimeHarness({ goal: makeGoal() });
        runtime.onTurnStart();
        expect(privRuntime(runtime).wallClock.activeGoalId).not.toBeNull();
    });
    it("clears token accounting baseline", () => {
        const { gm, runtime } = makeRuntimeHarness({ goal: makeGoal() });
        gm.computeAndAdvanceBaseline({ input: 100, cachedInput: 0, output: 50 });
        expect(priv(gm)._turnAccountingBaseline).not.toBeNull();
        runtime.onTurnStart();
        expect(priv(gm)._turnAccountingBaseline).toBeNull();
    });
    it("stops wall clock tracking for non-active goal", () => {
        const { runtime } = makeRuntimeHarness({ goal: makeGoal("test", undefined, "paused") });
        runtime.onTurnStart();
        expect(privRuntime(runtime).wallClock.activeGoalId).toBeNull();
    });
});
describe("onTurnEnd", () => {
    it("records turn evidence via gm.recordTurnEvidence", async () => {
        const { gm, runtime, ctx } = makeRuntimeHarness({ goal: makeGoal() });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "read", isError: false }, { toolName: "edit", isError: false }] }), ctx);
        await drainRuntime(runtime);
        expect(priv(gm).turnEvidence.length).toBeGreaterThan(0);
    });
    it("detects completion turn via toolCompletedGoalDone flag", async () => {
        const { gm, runtime, ctx } = makeRuntimeHarness({ goal: makeGoal() });
        runtime.onAgentStart();
        privRuntime(runtime).toolCompletedGoalDone = true;
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "read", isError: false }] }), ctx);
        await drainRuntime(runtime);
        expect(privRuntime(runtime).toolCompletedGoalDone).toBe(false);
    });
    it("detects completion turn when toolResults contains update_goal", async () => {
        const { gm, runtime, ctx } = makeRuntimeHarness({ goal: makeGoal() });
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "update_goal", isError: false }] }), ctx);
        await drainRuntime(runtime);
        expect(privRuntime(runtime).toolCompletedGoalDone).toBe(false);
    });
    it("failed update_goal does not suppress budget-limit steering", async () => {
        const { gm, runtime, ctx, messages } = makeRuntimeHarness({ goal: makeGoal("goal-near-limit", 10, "active") });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "update_goal", isError: true }], usage: { input: 20, cachedInput: 0, output: 0 } }), ctx);
        await drainRuntime(runtime);
        expect(gm.goal!.status).toBe("budget_limited");
        expect(findMessagesByCustomType(messages, "pi.goal.budget_limit")).toHaveLength(1);
    });
    it("advances wall clock with time delta", async () => {
        const { gm, runtime, ctx } = makeRuntimeHarness({ goal: makeGoal() });
        runtime.onTurnStart();
        const wc = privRuntime(runtime).wallClock;
        wc.lastAccountedAt = performance.now() - 5000;
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload(), ctx);
        await drainRuntime(runtime);
        expect(wc.lastAccountedAt).not.toBeNull();
    });
    it("calls gm.updateLiveFromTurn with the event", async () => {
        const { gm, runtime, ctx } = makeRuntimeHarness({ goal: makeGoal() });
        let called = false;
        const orig = gm.updateLiveFromTurn.bind(gm);
        (gm as any).updateLiveFromTurn = (e: TurnEndEvent) => { called = true; orig(e); };
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "edit", isError: false }] }), ctx);
        await drainRuntime(runtime);
        expect(called).toBe(true);
    });
    it("applies status line via ctx.ui.setStatus", async () => {
        const statusCalls: [
            string,
            string | undefined
        ][] = [];
        const ctx = makeExtensionContext({
            branchEntries: [],
            hasUI: false,
            onStatus: (k: string, t: string | undefined) => statusCalls.push([k, t]),
        });
        const { gm, runtime } = makeRuntimeHarness({ goal: makeGoal() });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload(), ctx);
        await drainRuntime(runtime);
        expect(statusCalls.some(([k]) => k === "goal")).toBe(true);
    });
    it("increments continuationToolCount for non-goal tools", async () => {
        const { gm, runtime, ctx } = makeRuntimeHarness({ goal: makeGoal() });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "read", isError: false }, { toolName: "edit", isError: false }, { toolName: "get_goal", isError: false }] }), ctx);
        await drainRuntime(runtime);
        expect(privRuntime(runtime).continuationToolCount).toBe(2);
    });
    it("does not persist completed usage when complete-goal accounting is gated", async () => {
        const { gm, runtime, ctx, entries } = makeRuntimeHarness({ goal: makeGoal("done-goal", undefined, "complete") });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ usage: { input: 40, cachedInput: 0, output: 0 } }), ctx);
        await drainRuntime(runtime);
        const completedSnapshots = entries.filter((e) => e.type === SNAPSHOT_CUSTOM_TYPE && (e.data as {
            reason?: string;
        })?.reason === "completed");
        expect(completedSnapshots).toHaveLength(0);
    });
    it("persists completed usage for the single allowed completion pass", async () => {
        const { gm, runtime, ctx, entries } = makeRuntimeHarness();
        gm.create("done-goal");
        gm.complete(gm.goal!.id);
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ usage: { input: 40, cachedInput: 0, output: 0 } }), ctx);
        await drainRuntime(runtime);
        const completedSnapshots = entries.filter((e) => e.type === SNAPSHOT_CUSTOM_TYPE && (e.data as {
            reason?: string;
        })?.reason === "completed");
        expect(completedSnapshots).toHaveLength(1);
    });
});
describe("onAgentEnd", () => {
  it("pauses goal and persists 'paused' when aborted with active goal and wall clock", async () => {
    const { gm, runtime, entries, api } = makeRuntimeHarness({ goal: makeGoal() });
    runtime.onTurnStart();
    runtime.onAgentStart();
    const ctx = makeExtensionContext({ branchEntries: [], hasUI: false, aborted: true });
    runtime.onAgentEnd({} as AgentEndEvent, ctx);
    await drainRuntime(runtime);
    expect(gm.goal!.status).toBe("paused");
    expect(gm.goal!.pauseReason).toBe("abort");
    const pausedCall = entries.find(
      (e) => e.type === SNAPSHOT_CUSTOM_TYPE && (e.data as { reason?: string })?.reason === "paused",
    );
    expect(pausedCall).toBeDefined();
  });
    it("does not pause when aborted but goal is not active", async () => {
        const { gm, runtime } = makeRuntimeHarness({ goal: makeGoal("test", undefined, "paused") });
        const ctx = makeCtx({ signal: { aborted: true } as any });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onAgentEnd({} as AgentEndEvent, ctx);
        await drainRuntime(runtime);
        expect(gm.goal!.status).toBe("paused");
    });
    it("requests continuation when not aborted and not stalled", async () => {
        const { gm, runtime, messages, api } = makeRuntimeHarness({ goal: makeGoal() });
        persistGoal(api, gm.goal!, "created");
        const ctx = makeCtxWithPersistedGoal(gm.goal!);
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "read", isError: false }] }), ctx);
        await drainRuntime(runtime);
        runtime.onAgentEnd({} as AgentEndEvent, ctx);
        await drainRuntime(runtime);
        expect(privRuntime(runtime).continuationTriggerPending).toBe(true);
    });
    it("does NOT request continuation when stalled (continuationTurnActive && toolCount===0)", async () => {
        const { gm, runtime, ctx } = makeRuntimeHarness({ goal: makeGoal() });
        runtime.onTurnStart();
        runtime.onAgentStart();
        privRuntime(runtime).continuationTurnActive = true;
        runtime.onTurnEnd(turnEndPayload({ toolResults: [] }), ctx);
        await drainRuntime(runtime);
        runtime.onAgentEnd({} as AgentEndEvent, ctx);
        await drainRuntime(runtime);
        expect(privRuntime(runtime).continuationToolCount).toBe(0);
        expect(privRuntime(runtime).continuationTurnActive).toBe(true);
    });
    it("syncs budget steering marker and applies status line", async () => {
        const statusCalls: [
            string,
            string | undefined
        ][] = [];
        const ctx = makeExtensionContext({
            branchEntries: [],
            hasUI: false,
            onStatus: (k: string, t: string | undefined) => statusCalls.push([k, t]),
        });
        const { gm, runtime } = makeRuntimeHarness({ goal: makeGoal("test", 100, "budget_limited") });
        runtime.onAgentStart();
        runtime.onAgentEnd({} as AgentEndEvent, ctx);
        await drainRuntime(runtime);
        expect(statusCalls.some(([k]) => k === "goal")).toBe(true);
        expect(privRuntime(runtime).budgetSteeringSentForGoalId).toBeNull();
    });
});
describe("onSessionShutdown", () => {
    it("syncs budget steering marker and applies status line", () => {
        const statusCalls: [
            string,
            string | undefined
        ][] = [];
        const ctx = makeExtensionContext({
            branchEntries: [],
            hasUI: false,
            onStatus: (k: string, t: string | undefined) => statusCalls.push([k, t]),
        });
        const { gm, runtime } = makeRuntimeHarness({ goal: makeGoal("shutdown-test", 100, "budget_limited") });
        runtime.onSessionShutdown(ctx);
        expect(statusCalls.some(([k]) => k === "goal")).toBe(true);
        expect(privRuntime(runtime).budgetSteeringSentForGoalId).toBeNull();
    });
});
describe("requestContinuation", () => {
    it("does not dispatch when no goal exists", () => {
        const { runtime, messages } = makeRuntimeHarness();
        runtime.requestContinuation();
        expect(messages.length).toBe(0);
    });
    it("does not dispatch when goal status is not active", () => {
        const { runtime, messages } = makeRuntimeHarness({ goal: makeGoal("test", undefined, "complete") });
        runtime.requestContinuation();
        expect(messages.length).toBe(0);
    });
    it("does not dispatch when agentRunning is true", () => {
        const { runtime, messages } = makeRuntimeHarness({ goal: makeGoal() });
        privRuntime(runtime).agentRunning = true;
        runtime.requestContinuation();
        expect(messages.length).toBe(0);
    });
    it("does not dispatch when continuationTriggerPending is true", () => {
        const { runtime, messages } = makeRuntimeHarness({ goal: makeGoal() });
        privRuntime(runtime).continuationTriggerPending = true;
        runtime.requestContinuation();
        expect(messages.length).toBe(0);
    });
    it("does not dispatch when dispatchScheduled is true", () => {
        const { runtime, messages } = makeRuntimeHarness({ goal: makeGoal() });
        privRuntime(runtime).dispatchScheduled = true;
        runtime.requestContinuation();
        expect(messages.length).toBe(0);
    });
    it("does not dispatch when hasPendingMessages() is true", () => {
        const { runtime, messages } = makeRuntimeHarness({ goal: makeGoal() });
        const ctx = makeCtx({ hasPendingMessages: () => true } as any);
        runtime.requestContinuation(ctx);
        expect(messages.length).toBe(0);
    });
    it("does not dispatch when isIdle() is false", () => {
        const { runtime, messages } = makeRuntimeHarness({ goal: makeGoal() });
        const ctx = makeCtx({ isIdle: () => false } as any);
        runtime.requestContinuation(ctx);
        expect(messages.length).toBe(0);
    });
    it("deduplicates continuation when dispatch is waiting for lifecycle drain", async () => {
        const { gm, runtime, api, messages } = makeRuntimeHarness({ goal: makeGoal() });
        persistGoal(api, gm.goal!, "created");
        const ctx = makeCtxWithPersistedGoal(gm.goal!);
        runtime.onAgentStart();
        privRuntime(runtime).agentRunning = false;
        let releaseLifecycle: (() => void) | null = null;
        privRuntime(runtime).lifecycleTail = new Promise<void>((resolve) => { releaseLifecycle = resolve; });
        runtime.requestContinuation(ctx);
        await new Promise((r) => setTimeout(r, 0));
        runtime.requestContinuation(ctx);
        releaseLifecycle?.();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        expect(findMessagesByCustomType(messages, "pi.goal.continuation")).toHaveLength(1);
    });
});
describe("dispatchContinuation", () => {
    it("waits for lifecycle drain before deciding", async () => {
        const { gm, runtime, ctx } = makeRuntimeHarness({ goal: makeGoal() });
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload(), ctx);
        const tail = privRuntime(runtime).lifecycleTail;
        expect(tail).toBeInstanceOf(Promise);
        await (privRuntime(runtime)).waitForLifecycleDrain?.();
    });
  it("reconciles gm.goal from loadGoalFromBranch when stale (no persisted goal)", async () => {
    const mock = makeMockApi();
    const gm = new GoalManager();
    gm.goal = makeGoal();
    const runtime = new GoalRuntime(mock.api as any, gm);
    const emptyCtx = makeExtensionContext({ branchEntries: [], idle: true });
    runtime.onAgentStart();
    privRuntime(runtime).agentRunning = false;
    await (privRuntime(runtime)).dispatchContinuation(emptyCtx);
    expect(gm.goal).toBeNull();
  });
  it("increments sequence, persists usage, and sends continuation message when active and idle", async () => {
    const { gm, runtime, api, messages, branchEntries } = makeRuntimeHarness({ goal: makeGoal() });
    persistGoal(api, gm.goal!, "created");
    const ctx = makeCtxWithPersistedGoal(gm.goal!);
    runtime.onAgentStart();
    runtime.onTurnEnd(turnEndPayload(), ctx);
    await drainRuntime(runtime);
    const h2 = makeRuntimeHarness({ goal: gm.goal! });
    persistGoal(h2.api, gm.goal!, "created");
    const ctx2 = makeExtensionContext({ branchEntries: h2.branchEntries, idle: true });
    h2.runtime.onAgentStart();
    privRuntime(h2.runtime).agentRunning = false;
    await (privRuntime(h2.runtime)).dispatchContinuation(ctx2);
    expect(gm.goal!.continuationSequence).toBe(1);
    const usageCall = h2.entries.find(
      (e) => e.type === SNAPSHOT_CUSTOM_TYPE && (e.data as { reason?: string })?.reason === "usage",
    );
    expect(usageCall).toBeDefined();
    const contMsg = findMessagesByCustomType(h2.messages, "pi.goal.continuation");
    expect(contMsg).toHaveLength(1);
    expect((contMsg[0].msg as any).customType).toBe("pi.goal.continuation");
    expect(contMsg[0].opts).toMatchObject({ triggerTurn: true });
    expect(privRuntime(h2.runtime).continuationTriggerPending).toBe(true);
  });
    it("sets continuationTriggerPending to true when dispatching", async () => {
        const { gm, runtime, api } = makeRuntimeHarness({ goal: makeGoal() });
        persistGoal(api, gm.goal!, "created");
        const ctx = makeCtxWithPersistedGoal(gm.goal!);
        runtime.onAgentStart();
        expect(privRuntime(runtime).continuationTriggerPending).toBe(false);
        privRuntime(runtime).agentRunning = false;
        await (privRuntime(runtime)).dispatchContinuation(ctx);
        expect(privRuntime(runtime).continuationTriggerPending).toBe(true);
    });
});
describe("continuation CAS race", () => {
    it("no continuation sent when goal cleared before dispatch", async () => {
        const mock = makeMockApi({ allTools: [] });
        const gm = new GoalManager();
        const runtime = new GoalRuntime(mock.api as any, gm);
        gm.create("clear test", 100);
        persistGoal(mock.api, gm.goal, "created");
        const ctx = makeExtensionContext({
            branchEntries: mock.branchEntries,
            idle: true,
        });
        runtime.requestContinuation(ctx);
        gm.clear();
        mock.branchEntries.push({
            type: "custom",
            customType: "goal.snapshot",
            data: { reason: "cleared", goal: null },
        } as any);
        await drainRuntime(runtime);
        expect(findMessagesByCustomType(mock.messages, "pi.goal.continuation")).toHaveLength(0);
        expect(gm.goal).toBeNull();
    });
    it("branch revision mismatch reconciles gm.goal from branch", async () => {
        const mock = makeMockApi({ allTools: [] });
        const gm = new GoalManager();
        const runtime = new GoalRuntime(mock.api as any, gm);
        gm.create("in-memory goal");
        gm.goal!.id = "X";
        gm.goal!.revision = 5;
        persistGoal(mock.api, gm.goal, "created");
        mock.branchEntries.length = 0;
        mock.branchEntries.push({
            type: "custom",
            customType: "goal.snapshot",
            data: {
                reason: "updated",
                goal: {
                    schemaVersion: 1, id: "X", revision: 99, objective: "branch version",
                    status: "paused", tokensUsed: 0, timeUsedSeconds: 0,
                    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
                    continuationSequence: 10,
                },
            },
        } as any);
        const ctx = makeExtensionContext({ branchEntries: mock.branchEntries, idle: true });
        runtime.requestContinuation(ctx);
        await drainRuntime(runtime);
        expect(findMessagesByCustomType(mock.messages, "pi.goal.continuation")).toHaveLength(0);
        expect(gm.goal!.id).toBe("X");
        expect(gm.goal!.revision).toBe(99);
        expect(gm.goal!.status).toBe("paused");
    });
    it("dispatch drops continuation when branch goal is null (cleared externally)", async () => {
        const mock = makeMockApi({ allTools: [] });
        const gm = new GoalManager();
        const runtime = new GoalRuntime(mock.api as any, gm);
        gm.create("in-memory");
        persistGoal(mock.api, gm.goal, "created");
        mock.branchEntries.push({
            type: "custom", customType: "goal.snapshot",
            data: { reason: "cleared", goal: null },
        } as any);
        const ctx = makeExtensionContext({ branchEntries: mock.branchEntries, idle: true });
        runtime.requestContinuation(ctx);
        await drainRuntime(runtime);
        expect(findMessagesByCustomType(mock.messages, "pi.goal.continuation")).toHaveLength(0);
        expect(gm.goal).toBeNull();
    });
    it("dispatch drops continuation when branch goal is not active", async () => {
        const mock = makeMockApi({ allTools: [] });
        const gm = new GoalManager();
        const runtime = new GoalRuntime(mock.api as any, gm);
        gm.create("in-memory active");
        persistGoal(mock.api, gm.goal, "created");
        mock.branchEntries.length = 0;
        mock.branchEntries.push({
            type: "custom", customType: "goal.snapshot",
            data: { reason: "completed", goal: { ...gm.goal, status: "complete", completedAt: "2026-01-01T00:00:00.000Z" } },
        } as any);
        const ctx = makeExtensionContext({ branchEntries: mock.branchEntries, idle: true });
        runtime.requestContinuation(ctx);
        await drainRuntime(runtime);
        expect(findMessagesByCustomType(mock.messages, "pi.goal.continuation")).toHaveLength(0);
        expect(gm.goal!.status).toBe("complete");
    });
    it("lifecycle queue survives throwing task", async () => {
        const mock = makeMockApi();
        const gm = new GoalManager();
        const runtime = new GoalRuntime(mock.api as any, gm);
        let counter = 0;
        (privRuntime(runtime)).queueLifecycle(async () => { counter++; throw new Error("fail"); });
        (privRuntime(runtime)).queueLifecycle(async () => { counter++; });
        (privRuntime(runtime)).queueLifecycle(async () => { counter++; });
        await (privRuntime(runtime)).waitForLifecycleDrain();
        expect(counter).toBe(3);
    });
    it("continuation pump works after lifecycle error", async () => {
        const mock = makeMockApi({ allTools: [] });
        const gm = new GoalManager();
        const runtime = new GoalRuntime(mock.api as any, gm);
        (privRuntime(runtime)).queueLifecycle(async () => { throw new Error("inject"); });
        gm.create("post-error goal", 100);
        persistGoal(mock.api, gm.goal, "created");
        (privRuntime(runtime)).queueLifecycle(async () => { });
        await (privRuntime(runtime)).waitForLifecycleDrain();
        const ctx = makeExtensionContext({ branchEntries: mock.branchEntries, idle: true });
        runtime.requestContinuation(ctx);
        await drainRuntime(runtime);
        expect(findMessagesByCustomType(mock.messages, "pi.goal.continuation")).toHaveLength(1);
    });
});
describe("completion turn budget crossing", () => {
    it("completion turn does not send budget-limit steer", async () => {
        const { gm, runtime, ctx, messages } = makeRuntimeHarness({ goal: makeGoal("cross budget", 100) });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "update_goal", isError: false }], usage: { input: 150, cachedInput: 0, output: 0 } }), ctx);
        await drainRuntime(runtime);
        runtime.onAgentEnd({} as any, ctx);
        await drainRuntime(runtime);
        expect(findMessagesByCustomType(messages, "pi.goal.budget_limit")).toHaveLength(0);
    });
    it("non-completion turn over budget sends budget-limit steer", async () => {
        const { gm, runtime, ctx, messages } = makeRuntimeHarness({ goal: makeGoal("non-completion over", 20) });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "edit", isError: false }], usage: { input: 50, cachedInput: 0, output: 0 } }), ctx);
        await drainRuntime(runtime);
        runtime.onAgentEnd({} as any, ctx);
        await drainRuntime(runtime);
        expect(gm.goal!.status).toBe("budget_limited");
        expect(findMessagesByCustomType(messages, "pi.goal.budget_limit")).toHaveLength(1);
    });
});
describe("budget-limit steer lifecycle", () => {
    it("exactly one steer sent per goal id", async () => {
        const { gm, runtime, ctx, messages } = makeRuntimeHarness({ goal: makeGoal("steer test", 30) });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "edit", isError: false }], usage: { input: 50, cachedInput: 0, output: 0 } }), ctx);
        await drainRuntime(runtime);
        runtime.onAgentEnd({} as any, ctx);
        await drainRuntime(runtime);
        expect(findMessagesByCustomType(messages, "pi.goal.budget_limit")).toHaveLength(1);
        runtime.onAgentStart();
        runtime.onTurnStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [], usage: { input: 5, cachedInput: 0, output: 0 } }), ctx);
        await drainRuntime(runtime);
        runtime.onAgentEnd({} as any, ctx);
        await drainRuntime(runtime);
        expect(findMessagesByCustomType(messages, "pi.goal.budget_limit")).toHaveLength(1);
    });
    it("replacing goal resets steer deduplication", async () => {
        const { gm, runtime, ctx, messages } = makeRuntimeHarness({ goal: makeGoal("original", 20) });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "edit", isError: false }], usage: { input: 30, cachedInput: 0, output: 0 } }), ctx);
        await drainRuntime(runtime);
        runtime.onAgentEnd({} as any, ctx);
        await drainRuntime(runtime);
        expect(findMessagesByCustomType(messages, "pi.goal.budget_limit")).toHaveLength(1);
        gm.create("replaced", 20);
        runtime.onAgentStart();
        runtime.onTurnStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "edit", isError: false }], usage: { input: 30, cachedInput: 0, output: 0 } }), ctx);
        await drainRuntime(runtime);
        runtime.onAgentEnd({} as any, ctx);
        await drainRuntime(runtime);
        expect(findMessagesByCustomType(messages, "pi.goal.budget_limit")).toHaveLength(2);
    });
    it("raising budget clears steer marker (budget_limited → active)", async () => {
        const { gm, runtime, ctx, messages } = makeRuntimeHarness({ goal: makeGoal("clear steer marker", 20) });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "edit", isError: false }], usage: { input: 30, cachedInput: 0, output: 0 } }), ctx);
        await drainRuntime(runtime);
        runtime.onAgentEnd({} as any, ctx);
        await drainRuntime(runtime);
        expect(gm.goal!.status).toBe("budget_limited");
        expect(privRuntime(runtime).budgetSteeringSentForGoalId).toBe(gm.goal!.id);
        gm.updateBudget(100, gm.goal!.id);
        expect(gm.goal!.status).toBe("active");
        runtime.onSessionShutdown(ctx);
        expect(privRuntime(runtime).budgetSteeringSentForGoalId).toBeNull();
    });
    it("removing budget clears steer marker", async () => {
        const { gm, runtime, ctx } = makeRuntimeHarness({ goal: makeGoal("remove budget", 20) });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "edit", isError: false }], usage: { input: 30, cachedInput: 0, output: 0 } }), ctx);
        await drainRuntime(runtime);
        runtime.onAgentEnd({} as any, ctx);
        await drainRuntime(runtime);
        expect(gm.goal!.status).toBe("budget_limited");
        expect(privRuntime(runtime).budgetSteeringSentForGoalId).toBe(gm.goal!.id);
        gm.updateBudget(undefined, gm.goal!.id);
        expect(gm.goal!.status).toBe("active");
        runtime.onSessionShutdown(ctx);
        expect(privRuntime(runtime).budgetSteeringSentForGoalId).toBeNull();
    });
});
describe("maybeSteerBudgetLimit", () => {
    it("sends budget limit steer message only once per goal id", async () => {
        const { gm, runtime, ctx, messages } = makeRuntimeHarness({ goal: makeGoal("dedup-test", 50, "budget_limited") });
        runtime.onAgentStart();
        await runtime.runGoalMutation(ctx, undefined, async () => { });
        await runtime.runGoalMutation(ctx, undefined, async () => { });
        const steerCalls = findMessagesByCustomType(messages, "pi.goal.budget_limit");
        expect(steerCalls).toHaveLength(1);
        const msg = steerCalls[0].msg as Record<string, unknown>;
        expect(msg.customType).toBe("pi.goal.budget_limit");
        expect(msg.display).toBe(false);
        expect(steerCalls[0].opts).toMatchObject({ deliverAs: "steer", triggerTurn: false });
    });
    it("does not send steer when agentRunning is false", () => {
        const { runtime, messages } = makeRuntimeHarness({ goal: makeGoal("no-steer", 50, "budget_limited") });
        privRuntime(runtime).maybeSteerBudgetLimit();
        expect(findMessagesByCustomType(messages, "pi.goal.budget_limit")).toHaveLength(0);
    });
    it("does not send steer when goal status is not budget_limited", () => {
        const { runtime, messages } = makeRuntimeHarness({ goal: makeGoal("not-limited", 50, "active") });
        privRuntime(runtime).agentRunning = true;
        privRuntime(runtime).maybeSteerBudgetLimit();
        expect(findMessagesByCustomType(messages, "pi.goal.budget_limit")).toHaveLength(0);
    });
});
describe("runGoalMutation", () => {
    it("serializes via mutex — concurrent calls execute sequentially", async () => {
        const { gm, runtime, ctx } = makeRuntimeHarness({ goal: makeGoal() });
        const order: number[] = [];
        await Promise.all([
            runtime.runGoalMutation(ctx, undefined, async () => { order.push(1); await new Promise((r) => setTimeout(r, 10)); order.push(2); }),
            runtime.runGoalMutation(ctx, undefined, async () => { order.push(3); }),
        ]);
        expect(order).toEqual([1, 2, 3]);
    });
    it("flushes turn time before fn", async () => {
        const { gm, runtime, ctx } = makeRuntimeHarness({ goal: makeGoal() });
        runtime.onTurnStart();
        let flushed = false;
        (runtime as any).flushTurnTimeOnly = () => { flushed = true; };
        await runtime.runGoalMutation(ctx, undefined, async () => { });
        expect(flushed).toBe(true);
    });
    it("syncs wall clock after fn", async () => {
        const { gm, runtime, ctx } = makeRuntimeHarness({ goal: makeGoal() });
        await runtime.runGoalMutation(ctx, undefined, async () => { });
        expect(privRuntime(runtime).wallClock.activeGoalId).not.toBeNull();
    });
    it("syncs budget steering marker after fn", async () => {
        const { gm, runtime, ctx } = makeRuntimeHarness({ goal: makeGoal() });
        await runtime.runGoalMutation(ctx, undefined, async () => { });
        expect(privRuntime(runtime).budgetSteeringSentForGoalId).toBeNull();
    });
    it("applies status line after fn", async () => {
        const statusCalls: [
            string,
            string | undefined
        ][] = [];
        const ctx = makeExtensionContext({
            branchEntries: [],
            hasUI: false,
            onStatus: (k: string, t: string | undefined) => statusCalls.push([k, t]),
        });
        const { gm, runtime } = makeRuntimeHarness({ goal: makeGoal() });
        await runtime.runGoalMutation(ctx, undefined, async () => { });
        expect(statusCalls.some(([k]) => k === "goal")).toBe(true);
    });
    it("optionally requests continuation after fn", async () => {
        const { gm, runtime, api, messages } = makeRuntimeHarness({ goal: makeGoal() });
        persistGoal(api, gm.goal!, "created");
        const ctx = makeCtxWithPersistedGoal(gm.goal!);
        privRuntime(runtime).agentRunning = false;
        await runtime.runGoalMutation(ctx, { requestContinuation: true }, async () => { });
        await new Promise((r) => setTimeout(r, 0));
        expect(findMessagesByCustomType(messages, "pi.goal.continuation")).toHaveLength(1);
    });
    it("propagates fn errors", async () => {
        const { gm, runtime, ctx } = makeRuntimeHarness({ goal: makeGoal() });
        await expect(runtime.runGoalMutation(ctx, undefined, async () => { throw new Error("mutation-fail"); })).rejects.toThrow("mutation-fail");
    });
});
describe("continuation stall", () => {
    it("continuation turn calls only get_goal → toolCount=0", async () => {
        const { gm, runtime, ctx, messages } = makeRuntimeHarness({ goal: makeGoal("stall test", 1000) });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "get_goal", isError: false }], usage: { input: 5, cachedInput: 0, output: 0 } }), ctx);
        await drainRuntime(runtime);
        expect(privRuntime(runtime).continuationToolCount).toBe(0);
        expect(findMessagesByCustomType(messages, "pi.goal.continuation")).toHaveLength(0);
    });
    it("continuation turn calls zero tools → toolCount=0", async () => {
        const { gm, runtime, ctx, messages } = makeRuntimeHarness({ goal: makeGoal("stall test", 1000) });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [], usage: { input: 5, cachedInput: 0, output: 0 } }), ctx);
        await drainRuntime(runtime);
        expect(privRuntime(runtime).continuationToolCount).toBe(0);
        expect(findMessagesByCustomType(messages, "pi.goal.continuation")).toHaveLength(0);
    });
    it("continuation turn calls non-goal tool → toolCount>0", async () => {
        const { gm, runtime, ctx, messages } = makeRuntimeHarness({ goal: makeGoal("stall test", 1000) });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "bash", isError: true }], usage: { input: 5, cachedInput: 0, output: 0 } }), ctx);
        await drainRuntime(runtime);
        expect(privRuntime(runtime).continuationToolCount).toBe(1);
    });
    it("stalled turn does not emit continuation (agentRunning=true blocks requestContinuation)", async () => {
        const { gm, runtime, ctx, messages } = makeRuntimeHarness({ goal: makeGoal("stall test", 1000) });
        runtime.onTurnStart();
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "get_goal", isError: false }], usage: { input: 5, cachedInput: 0, output: 0 } }), ctx);
        await drainRuntime(runtime);
        expect(findMessagesByCustomType(messages, "pi.goal.continuation")).toHaveLength(0);
    });
});
describe("setCompletedFlag + completion turn budget steering suppression", () => {
    it("setCompletedFlag sets toolCompletedGoalDone to true", () => {
        const { gm, runtime } = makeRuntimeHarness({ goal: makeGoal() });
        expect(privRuntime(runtime).toolCompletedGoalDone).toBe(false);
        runtime.toolCompletedGoalDone = true;
        expect(privRuntime(runtime).toolCompletedGoalDone).toBe(true);
    });
    it("completion turn via update_goal in toolResults clears flag after turn", async () => {
        const { gm, runtime, ctx } = makeRuntimeHarness({ goal: makeGoal("suppress-test", 50, "active") });
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "update_goal", isError: false }] }), ctx);
        await drainRuntime(runtime);
        expect(privRuntime(runtime).toolCompletedGoalDone).toBe(false);
    });
    it("non-completion turn sends budget steering normally", async () => {
        const { gm, runtime, ctx, messages } = makeRuntimeHarness({ goal: makeGoal("normal-steer", 10, "budget_limited") });
        const usage = { input: 20, cachedInput: 0, output: 0 };
        gm.computeAndAdvanceBaseline(usage);
        runtime.onAgentStart();
        runtime.onTurnEnd(turnEndPayload({ toolResults: [{ toolName: "edit", isError: false }], usage }), ctx);
        await drainRuntime(runtime);
        privRuntime(runtime).maybeSteerBudgetLimit();
        const steers = findMessagesByCustomType(messages, "pi.goal.budget_limit");
        expect(steers.length).toBeGreaterThan(0);
        const msg = steers[0].msg as Record<string, unknown>;
        expect(msg.customType).toBe("pi.goal.budget_limit");
        expect(msg.display).toBe(false);
        expect(steers[0].opts).toMatchObject({ deliverAs: "steer", triggerTurn: false });
    });
});
