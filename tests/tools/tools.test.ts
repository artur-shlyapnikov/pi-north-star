import { describe, it, expect, beforeEach } from "bun:test";
import { GoalManager } from "../../src/goal/goal-manager";
import { registerGoalTools } from "../../src/tools/register-goal-tools";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AppendedEntry, CapturedMessage, SessionEntry } from "../../src/goal/goal-types";
import { makeExtensionContext } from "../fixtures/test-fixtures";
function mockApi(): {
    api: ExtensionAPI;
    toolDefs: Map<string, {
        execute: (...args: unknown[]) => unknown;
        params: unknown;
    }>;
    appendEntries: AppendedEntry[];
    messages: CapturedMessage[];
} {
    const toolDefs = new Map();
    const appendEntries: AppendedEntry[] = [];
    const messages: CapturedMessage[] = [];
    const api: ExtensionAPI = {
        registerTool: (def: unknown) => {
            toolDefs.set(def.name, { execute: def.execute, params: def.parameters });
        },
        appendEntry: (type: string, data: unknown) => {
            appendEntries.push({ type, data });
        },
        sendMessage: (msg: unknown, opts?: unknown) => {
            messages.push({ msg, opts });
        },
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => { },
        on: () => { },
    } as unknown;
    return { api, toolDefs, appendEntries, messages };
}
function mockRuntime(): {
    runGoalMutation: <T>(ctx: ExtensionContext | undefined, options: unknown, fn: () => Promise<T> | T) => Promise<T>;
    toolCompletedGoalDone: boolean;
    mutationCalls: Array<{
        ctx: ExtensionContext | undefined;
        options: unknown;
    }>;
    completedFlagSet: boolean;
} {
    const mutationCalls: Array<{
        ctx: ExtensionContext | undefined;
        options: unknown;
    }> = [];
    let completedFlagSet = false;
    return {
        runGoalMutation: <T>(ctx: ExtensionContext | undefined, options: unknown, fn: () => Promise<T> | T): Promise<T> => {
            mutationCalls.push({ ctx, options });
            return Promise.resolve(fn());
        },
        set toolCompletedGoalDone(v: boolean) {
            completedFlagSet = v;
        },
        get toolCompletedGoalDone(): boolean {
            return completedFlagSet;
        },
        mutationCalls,
        get completedFlagSet(): boolean {
            return completedFlagSet;
        },
    };
}
function mockCtx(branchEntries?: SessionEntry[]): ExtensionContext {
    return makeExtensionContext({ branchEntries });
}
function parseToolResponse(response: unknown): unknown {
    return JSON.parse(response.content[0].text);
}
interface ToolFixture {
    api: ExtensionAPI;
    toolDefs: Map<string, {
        execute: (...args: unknown[]) => unknown;
        params: unknown;
    }>;
    entries: AppendedEntry[];
    messages: CapturedMessage[];
    gm: GoalManager;
    runtime: ReturnType<typeof mockRuntime>;
}
function setup(): ToolFixture {
    const { api, toolDefs, appendEntries, messages } = mockApi();
    const gm = new GoalManager();
    const runtime = mockRuntime();
    registerGoalTools(api, gm, runtime as unknown);
    return { api, toolDefs, entries: appendEntries, messages, gm, runtime };
}
describe("get_goal", () => {
    let fx: ToolFixture;
    beforeEach(() => {
        fx = setup();
    });
    it("returns goal=null when no goal exists", async () => {
        const response = await fx.toolDefs.get("get_goal")!.execute();
        const data = parseToolResponse(response);
        expect(data).toEqual({ goal: null });
        expect(response.isError).toBeUndefined();
    });
    it("returns goal snapshot + remainingTokens when goal has budget", async () => {
        fx.gm.create("test objective", 1000);
        const response = await fx.toolDefs.get("get_goal")!.execute();
        const data = parseToolResponse(response);
        expect(data.goal).not.toBeNull();
        expect(data.goal.id).toBe(fx.gm.goal!.id);
        expect(data.goal.objective).toBe("test objective");
        expect(data.goal.tokenBudget).toBe(1000);
        expect(data.remainingTokens).toBe(1000);
        expect(data.completionBudgetReport).toBeNull();
        expect(response.isError).toBeUndefined();
    });
    it("returns remainingTokens=null when goal has no budget", async () => {
        fx.gm.create("unbounded");
        const response = await fx.toolDefs.get("get_goal")!.execute();
        const data = parseToolResponse(response);
        expect(data.remainingTokens).toBeNull();
        expect(data.completionBudgetReport).toBeNull();
    });
    it("computes remainingTokens correctly after usage", async () => {
        fx.gm.create("budgeted", 500);
        fx.gm.accumulateUsage(123, 0, fx.gm.goal!.id, "active_only");
        const response = await fx.toolDefs.get("get_goal")!.execute();
        const data = parseToolResponse(response);
        expect(data.remainingTokens).toBe(377);
    });
});
describe("update_goal", () => {
    let fx: ToolFixture;
    beforeEach(() => {
        fx = setup();
    });
    it("rejects status other than 'complete'", async () => {
        const response = await fx.toolDefs.get("update_goal")!.execute("call-1", { status: "incomplete" });
        expect(response.isError).toBe(true);
        const data = parseToolResponse(response);
        expect(data.error).toContain('Only status="complete"');
    });
    it.each([
        { setup: undefined, label: "no goal" },
        { setup: "paused:test", label: "paused" },
        { setup: "complete:test", label: "complete" },
        { setup: "budget_limited:test:10", label: "budget_limited" },
    ])("rejects when $label", async ({ setup }) => {
        if (setup) {
            const p = setup.split(":");
            if (p[0] === "paused") {
                fx.gm.create(p[1]);
                fx.gm.pause("user");
            }
            if (p[0] === "complete") {
                fx.gm.create(p[1]);
                fx.gm.goal!.status = "complete";
            }
            if (p[0] === "budget_limited") {
                fx.gm.create(p[1], Number(p[2]));
                fx.gm.accumulateUsage(20, 0, fx.gm.goal!.id, "active_only");
            }
        }
        const response = await fx.toolDefs.get("update_goal")!.execute("call-1", { status: "complete" });
        expect(response.isError).toBe(true);
        const data = parseToolResponse(response);
        expect(data.error).toContain("No active goal");
    });
    it("allows completion with verifier=off (default) — no evidence required", async () => {
        fx.gm.create("test");
        const response = await fx.toolDefs.get("update_goal")!.execute("call-1", { status: "complete" }, undefined, mockCtx());
        expect(response.isError).toBeUndefined();
        expect(response.terminate).toBe(true);
        const data = parseToolResponse(response);
        expect(data.goal.status).toBe("complete");
        expect(data.remainingTokens).toBeNull();
        expect(data.completionBudgetReport).toBeDefined();
        expect(data.completionBudgetReport.tokenBudget).toBeUndefined();
        expect(data.completionBudgetReport.withinBudget).toBe(true);
        const persistCall = fx.entries.find((e) => e.data?.reason === "completed");
        expect(persistCall).toBeDefined();
        expect(persistCall!.data.goal.status).toBe("complete");
        expect(fx.runtime.mutationCalls).toHaveLength(1);
    });
    it("completionBudgetReport withinBudget=true when under budget", async () => {
        fx.gm.create("budget test", 1000);
        fx.gm.accumulateUsage(400, 0, fx.gm.goal!.id, "active_only");
        const response = await fx.toolDefs.get("update_goal")!.execute("call-1", { status: "complete" }, undefined, mockCtx());
        const data = parseToolResponse(response);
        expect(data.completionBudgetReport.withinBudget).toBe(true);
        expect(data.completionBudgetReport.tokensUsed).toBe(400);
        expect(data.completionBudgetReport.tokenBudget).toBe(1000);
    });
    it("completionBudgetReport withinBudget=false when over budget", async () => {
        fx.gm.create("over test", 500);
        fx.gm.accumulateUsage(600, 0, fx.gm.goal!.id, "active_only");
        fx.gm.goal!.status = "active";
        const response = await fx.toolDefs.get("update_goal")!.execute("call-1", { status: "complete" }, undefined, mockCtx());
        const data = parseToolResponse(response);
        expect(data.completionBudgetReport.withinBudget).toBe(false);
        expect(data.completionBudgetReport.tokensUsed).toBe(600);
        expect(data.completionBudgetReport.tokenBudget).toBe(500);
    });
    describe("verifier=warn", () => {
        it("allows completion with strong evidence", async () => {
            fx.gm.create("test");
            fx.gm.setVerifierPolicy("warn");
            fx.gm.recordTurnEvidence([{ toolName: "edit" }]);
            fx.gm.recordTurnEvidence([{ toolName: "test" }]);
            const response = await fx.toolDefs.get("update_goal")!.execute("call-1", { status: "complete" }, undefined, mockCtx());
            expect(response.isError).toBeUndefined();
            expect(fx.gm.goal!.status).toBe("complete");
        });
    });
    describe("verifier=enforce", () => {
        it("blocks completion when evidence is empty", async () => {
            fx.gm.create("test");
            fx.gm.setVerifierPolicy("enforce");
            const response = await fx.toolDefs.get("update_goal")!.execute("call-1", { status: "complete" }, undefined, mockCtx());
            expect(response.isError).toBe(true);
            const data = parseToolResponse(response);
            expect(data.verifierResult).toBeDefined();
            expect(data.verifierResult.passed).toBe(false);
            expect(data.verifierResult.evidenceCount).toBe(0);
        });
        it.each([
            { label: "file_change + test_run", ev: [{ toolName: "edit" }, { toolName: "test" }] },
            { label: "file_change + command_output", ev: [{ toolName: "edit" }, { toolName: "bash" }] },
        ])("allows completion with $label", async ({ ev }) => {
            fx.gm.create("test");
            fx.gm.setVerifierPolicy("enforce");
            for (const e of ev)
                fx.gm.recordTurnEvidence([e]);
            const response = await fx.toolDefs.get("update_goal")!.execute("call-1", { status: "complete" }, undefined, mockCtx());
            expect(response.isError).toBeUndefined();
            expect(fx.gm.goal!.status).toBe("complete");
        });
    });
    it("detects stale goal — goal was paused/cleared before tool call", async () => {
        fx.gm.create("test");
        fx.gm.clear();
        const response = await fx.toolDefs.get("update_goal")!.execute("call-1", { status: "complete" });
        expect(response.isError).toBe(true);
        const data = parseToolResponse(response);
        expect(data.error).toContain("No active goal");
    });
    it("setCompletedFlag was set inside the mutation", async () => {
        fx.gm.create("test");
        await fx.toolDefs.get("update_goal")!.execute("call-1", { status: "complete" }, undefined, mockCtx());
        expect(fx.runtime.toolCompletedGoalDone).toBe(true);
    });
    it("normalizes malformed ctx (missing ui) to undefined", async () => {
        fx.gm.create("test");
        const badCtx = { ...mockCtx(), hasUI: true, ui: undefined } as unknown as ExtensionContext;
        const response = await fx.toolDefs.get("update_goal")!.execute("call-1", { status: "complete" }, undefined, badCtx);
        expect(response.isError).toBeUndefined();
        expect(fx.runtime.mutationCalls).toHaveLength(1);
        expect(fx.runtime.mutationCalls[0]!.ctx).toBeUndefined();
    });
});
describe("clear_goal", () => {
    let fx: ToolFixture;
    beforeEach(() => {
        fx = setup();
    });
    it("rejects when no goal exists", async () => {
        const response = await fx.toolDefs.get("clear_goal")!.execute("call-1", {});
        expect(response.isError).toBe(true);
        const data = parseToolResponse(response);
        expect(data.error).toContain("No active goal to clear");
    });
    it("clears goal successfully and persists cleared", async () => {
        fx.gm.create("test");
        const response = await fx.toolDefs.get("clear_goal")!.execute("call-1", {}, undefined, mockCtx());
        expect(response.isError).toBeUndefined();
        const data = parseToolResponse(response);
        expect(data.message).toContain("cleared");
        expect(fx.gm.goal).toBeNull();
        const persistCall = fx.entries.find((e) => e.data?.reason === "cleared");
        expect(persistCall).toBeDefined();
        expect(persistCall!.data.goal).toBeNull();
        expect(fx.runtime.mutationCalls).toHaveLength(1);
    });
    it("normalizes malformed ctx (missing ui) to undefined", async () => {
        fx.gm.create("test");
        const badCtx = { ...mockCtx(), hasUI: true, ui: undefined } as unknown as ExtensionContext;
        const response = await fx.toolDefs.get("clear_goal")!.execute("call-1", {}, undefined, badCtx);
        expect(response.isError).toBeUndefined();
        expect(fx.runtime.mutationCalls).toHaveLength(1);
        expect(fx.runtime.mutationCalls[0]!.ctx).toBeUndefined();
    });
    it.each([
        { setup: "paused:test", label: "paused" },
        { setup: "complete:test", label: "complete" },
        { setup: "budget_limited:test:10", label: "budget_limited" },
    ])("clears from $label status", async ({ setup }) => {
        const p = setup.split(":");
        if (p[0] === "paused") {
            fx.gm.create(p[1]);
            fx.gm.pause("user");
        }
        if (p[0] === "complete") {
            fx.gm.create(p[1]);
            fx.gm.goal!.status = "complete";
        }
        if (p[0] === "budget_limited") {
            fx.gm.create(p[1], Number(p[2]));
            fx.gm.accumulateUsage(20, 0, fx.gm.goal!.id, "active_only");
        }
        const response = await fx.toolDefs.get("clear_goal")!.execute("call-1", {}, undefined, mockCtx());
        expect(response.isError).toBeUndefined();
        expect(fx.gm.goal).toBeNull();
    });
});
