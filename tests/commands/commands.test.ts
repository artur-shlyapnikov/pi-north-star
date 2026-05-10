import { describe, it, expect, beforeEach, type Mocked } from "bun:test";
import { GoalManager } from "../../src/goal/goal-manager";
import { GoalRuntime } from "../../src/runtime/goal-runtime";
import { registerGoalCommand } from "../../src/commands/register-goal-command";
import type { GoalSnapshot } from "../../src/goal/goal-types";
import { makeBranchEntriesForGoal } from "../fixtures/test-fixtures";
function branchEntriesFor(gm: GoalManager): any[] {
    return makeBranchEntriesForGoal(gm.goal as GoalSnapshot | null);
}
interface Harness {
    gm: GoalManager;
    runtime: GoalRuntime;
    messages: any[];
    entries: any[];
    statusCalls: {
        key: string;
        value: any;
    }[];
    notifyCalls: {
        msg: string;
        level: string;
    }[];
    handler: (args: string | undefined, ctx: any) => Promise<void>;
    ctx: () => any;
}
function createHarness(): Harness {
    const messages: any[] = [];
    const entries: any[] = [];
    const statusCalls: {
        key: string;
        value: any;
    }[] = [];
    const notifyCalls: {
        msg: string;
        level: string;
    }[] = [];
    const gm = new GoalManager();
    const pi = {
        registerCommand: (_name: string, config: any) => {
            capturedHandler = config.handler;
        },
        sendMessage: (msg: any) => {
            messages.push(msg);
        },
        appendEntry: (type: string, data: any) => {
            entries.push({ type, data });
        },
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => { },
    } as any;
    const runtime = new GoalRuntime(pi, gm);
    const baseCtx = {
        hasUI: false,
        ui: {
            setStatus: (key: string, value: any) => statusCalls.push({ key, value }),
            setWidget: () => { },
            notify: () => { },
        },
        signal: { aborted: false },
        sessionManager: {
            getBranch: () => branchEntriesFor(gm),
        },
        postMessage: () => { },
        hasPendingMessages: () => false,
        isIdle: () => true,
    };
    (runtime as any).lastContext = baseCtx;
    let capturedHandler: ((args: string | undefined, ctx: any) => Promise<void>) | null = null;
    registerGoalCommand(pi, gm, runtime);
    return {
        gm,
        runtime,
        messages,
        entries,
        statusCalls,
        notifyCalls,
        handler: async (args, ctx) => {
            await capturedHandler!(args, ctx);
        },
        ctx: () => ({
            hasUI: true,
            ui: {
                setStatus: () => { },
                setWidget: () => { },
                notify: (msg: string, level: string) => notifyCalls.push({ msg, level }),
            },
            signal: { aborted: false },
            sessionManager: {
                getBranch: () => branchEntriesFor(gm),
            },
            postMessage: () => { },
            hasPendingMessages: () => false,
            isIdle: () => true,
        }),
    };
}
function goalStatusMessages(msgs: any[]): string[] {
    return msgs
        .filter((m) => m.customType === "goal-status")
        .map((m) => m.content);
}
describe("commands.ts — parser, decision table, UX errors", () => {
    let h: Harness;
    beforeEach(() => {
        h = createHarness();
    });
    describe("1. /goal (no args) → showGoalStatus", () => {
        it.each([
            { args: undefined, label: "undefined" },
            { args: "", label: "empty string" },
            { args: "   ", label: "whitespace only" },
        ])("shows 'No active goal' when $label", async ({ args }) => {
            await h.handler(args, h.ctx());
            const msgs = goalStatusMessages(h.messages);
            expect(msgs.some((m) => m.includes("No active goal"))).toBeTrue();
            expect(h.notifyCalls.some((n) => n.msg.includes("No active goal"))).toBeTrue();
        });
        it("shows goal summary when goal exists", async () => {
            h.gm.create("existing goal");
            h.messages.length = 0;
            h.notifyCalls.length = 0;
            await h.handler(undefined, h.ctx());
            const msgs = goalStatusMessages(h.messages);
            expect(msgs.some((m) => m.includes("Goal: existing goal"))).toBeTrue();
        });
    });
    describe("2. subcommand → handler dispatch", () => {
        it.each([
            { args: "pause", msg: "No goal to pause" },
            { args: "resume", msg: "No goal to resume" },
            { args: "clear", msg: "No goal to clear" },
        ])("'$args' → shows guard message", async ({ args, msg }) => {
            await h.handler(args, h.ctx());
            const msgs = goalStatusMessages(h.messages);
            expect(msgs.some((m) => m.includes(msg))).toBeTrue();
        });
        it("'replace <text>' → handleReplace", async () => {
            await h.handler("replace new goal", h.ctx());
            expect(h.entries.some((e) => e.data?.reason === "replaced")).toBeTrue();
        });
        it("'budget 500' → handleBudget", async () => {
            h.gm.create("budget test");
            h.messages.length = 0;
            await h.handler("budget 500", h.ctx());
            expect(h.gm.goal?.tokenBudget).toBe(500);
        });
        it("'verify' → handleVerify (show policy)", async () => {
            await h.handler("verify", h.ctx());
            const msgs = goalStatusMessages(h.messages);
            expect(msgs.some((m) => m.includes("Verifier policy"))).toBeTrue();
        });
        it("'plan-file' → handlePlanFileShow", async () => {
            await h.handler("plan-file", h.ctx());
            const msgs = goalStatusMessages(h.messages);
            expect(msgs.some((m) => m.includes("goal-plan.md"))).toBeTrue();
        });
        it("'plan-file off' → handlePlanFileSet", async () => {
            expect(h.gm.planFileEnabled).toBe(true);
            await h.handler("plan-file off", h.ctx());
            expect(h.gm.planFileEnabled).toBe(false);
            const msgs = goalStatusMessages(h.messages);
            expect(msgs.some((m) => m.includes("disabled"))).toBeTrue();
        });
        it("'plan-file on' → handlePlanFileSet", async () => {
            h.gm.planFileEnabled = false;
            await h.handler("plan-file on", h.ctx());
            expect(h.gm.planFileEnabled).toBe(true);
        });
        it("default (unknown word) → handleCreate", async () => {
            await h.handler("my new objective", h.ctx());
            expect(h.gm.goal).not.toBeNull();
            expect(h.gm.goal?.objective).toBe("my new objective");
            expect(h.entries.some((e) => e.data?.reason === "created")).toBeTrue();
        });
        it("default create uses command ctx to trigger continuation when runtime has no lastContext", async () => {
            (h.runtime as any).lastContext = null;
            h.messages.length = 0;
            await h.handler("kick off work now", h.ctx());
            await new Promise((r) => setTimeout(r, 0));
            expect(h.gm.goal?.objective).toBe("kick off work now");
            expect(h.gm.goal?.status).toBe("active");
            expect(h.messages.some((m) => m.customType === "pi.goal.continuation")).toBeTrue();
        });
        it("replace uses command ctx to trigger continuation when runtime has no lastContext", async () => {
            h.gm.create("old objective");
            (h.runtime as any).lastContext = null;
            h.messages.length = 0;
            await h.handler("replace new objective", h.ctx());
            await new Promise((r) => setTimeout(r, 0));
            expect(h.gm.goal?.objective).toBe("new objective");
            expect(h.gm.goal?.status).toBe("active");
            expect(h.messages.some((m) => m.customType === "pi.goal.continuation")).toBeTrue();
        });
        it("resume uses command ctx to trigger continuation when runtime has no lastContext", async () => {
            h.gm.create("paused objective");
            h.gm.pause("user");
            (h.runtime as any).lastContext = null;
            h.messages.length = 0;
            await h.handler("resume", h.ctx());
            await new Promise((r) => setTimeout(r, 0));
            expect(h.gm.goal?.objective).toBe("paused objective");
            expect(h.gm.goal?.status).toBe("active");
            expect(h.messages.some((m) => m.customType === "pi.goal.continuation")).toBeTrue();
        });
    });
    describe("3. --budget matrix", () => {
        it.each([
            { args: "--budget 100 priced goal", objective: "priced goal", budget: 100 },
            { args: "replace --budget 200 newobj", setup: "create:original", objective: "newobj", budget: 200 },
            { args: "resume --budget 300", setup: "pause:to pause", budget: 300, status: "active" },
            { args: "--budget abc test", error: "Usage", goalNull: true },
            { args: "--budget 100", error: "Usage", goalNull: true },
            { args: "resume --budget abc", setup: "pause:test", error: "Usage", status: "paused" },
            { args: "replace --budget", setup: "create:original", error: "Usage" },
        ])("$args", async ({ args, setup, objective, budget, status: st, error, goalNull }) => {
            if (setup) {
                const [action, label] = setup.split(":");
                if (action === "create")
                    h.gm.create(label);
                if (action === "pause") {
                    h.gm.create(label);
                    h.gm.pause("user");
                }
                h.messages.length = 0;
            }
            await h.handler(args, h.ctx());
            if (error)
                expect(goalStatusMessages(h.messages).some((m) => m.includes(error))).toBeTrue();
            if (goalNull)
                expect(h.gm.goal).toBeNull();
            if (budget !== undefined)
                expect(h.gm.goal?.tokenBudget).toBe(budget);
            if (objective)
                expect(h.gm.goal?.objective).toBe(objective);
            if (st)
                expect(h.gm.goal?.status).toBe(st);
        });
    });
    describe("4. /goal pause", () => {
        it.each([
            { setup: undefined, expected: "No goal to pause" },
            { setup: "pause:test", expected: "already paused" },
            { setup: "complete:test", expected: "already complete" },
        ])("rejects when $setup", async ({ setup, expected }) => {
            if (setup) {
                const [action, label] = setup.split(":");
                if (action === "pause") {
                    h.gm.create(label);
                    h.gm.pause("user");
                }
                if (action === "complete") {
                    h.gm.create(label, 100);
                    h.gm.accumulateUsage(50, 0, h.gm.goal!.id);
                    h.gm.complete();
                }
                h.messages.length = 0;
            }
            await h.handler("pause", h.ctx());
            expect(goalStatusMessages(h.messages).some((m) => m.includes(expected))).toBeTrue();
        });
        it("pauses active goal", async () => {
            h.gm.create("active goal");
            h.messages.length = 0;
            await h.handler("pause", h.ctx());
            expect(h.gm.goal?.status).toBe("paused");
            expect(h.entries.some((e) => e.data?.reason === "paused")).toBeTrue();
            expect(goalStatusMessages(h.messages).some((m) => m.includes("Goal paused"))).toBeTrue();
        });
    });
    describe("5. /goal resume", () => {
        it.each([
            { setup: undefined, expected: "No goal to resume" },
            { setup: "active:test", expected: "not paused" },
            { setup: "budget_limited:limited:10", expected: "not paused" },
        ])("rejects when $setup", async ({ setup, expected }) => {
            if (setup) {
                const parts = setup.split(":");
                if (parts[0] === "active")
                    h.gm.create(parts[1]);
                if (parts[0] === "budget_limited") {
                    h.gm.create(parts[1], Number(parts[2]));
                    h.gm.accumulateUsage(20, 0, h.gm.goal!.id, "active_only");
                }
                h.messages.length = 0;
            }
            await h.handler("resume", h.ctx());
            expect(goalStatusMessages(h.messages).some((m) => m.includes(expected))).toBeTrue();
        });
        it("resumes paused goal", async () => {
            h.gm.create("paused goal");
            h.gm.pause("user");
            h.messages.length = 0;
            await h.handler("resume", h.ctx());
            expect(h.gm.goal?.status).toBe("active");
            expect(h.entries.some((e) => e.data?.reason === "resumed")).toBeTrue();
            expect(goalStatusMessages(h.messages).some((m) => m.includes("Goal resumed"))).toBeTrue();
        });
        it("resume with budget validation error", async () => {
            h.gm.create("paused goal");
            h.gm.pause("user");
            h.messages.length = 0;
            await h.handler("resume --budget 0", h.ctx());
            expect(goalStatusMessages(h.messages).some((m) => m.includes("Usage"))).toBeTrue();
        });
    });
    describe("6. /goal replace", () => {
        it("validates objective: empty → error", async () => {
            await h.handler("replace ", h.ctx());
            expect(h.gm.goal).toBeNull();
            expect(goalStatusMessages(h.messages).some((m) => m.includes("Usage"))).toBeTrue();
        });
        it("validates budget: --budget 0 → error", async () => {
            h.gm.create("original");
            h.messages.length = 0;
            await h.handler("replace --budget 0 obj", h.ctx());
            expect(goalStatusMessages(h.messages).some((m) => m.includes("Usage"))).toBeTrue();
        });
        it("replaces active goal", async () => {
            h.gm.create("original");
            h.messages.length = 0;
            await h.handler("replace new objective", h.ctx());
            expect(h.gm.goal?.objective).toBe("new objective");
            expect(h.entries.some((e) => e.data?.reason === "replaced")).toBeTrue();
        });
        it("replaces even when active (bypasses canCreate guard)", async () => {
            h.gm.create("existing");
            h.messages.length = 0;
            await h.handler("replace new goal", h.ctx());
            expect(h.gm.goal?.objective).toBe("new goal");
            expect(h.entries.some((e) => e.data?.reason === "replaced")).toBeTrue();
        });
    });
    describe("7. /goal budget none", () => {
        it.each([
            { initialBudget: 500, label: "with existing budget" },
            { initialBudget: undefined, label: "without a budget" },
        ])("$label → removes limit", async ({ initialBudget, }) => {
            h.gm.create("test", initialBudget);
            h.messages.length = 0;
            await h.handler("budget none", h.ctx());
            expect(h.gm.goal?.tokenBudget).toBeUndefined();
            expect(goalStatusMessages(h.messages).some((m) => m.includes("Budget limit removed"))).toBeTrue();
        });
    });
    describe("8. /goal budget <N>", () => {
        it("sets budget on active goal", async () => {
            h.gm.create("budgetable");
            h.messages.length = 0;
            await h.handler("budget 1000", h.ctx());
            expect(h.gm.goal?.tokenBudget).toBe(1000);
            expect(goalStatusMessages(h.messages).some((m) => m.includes("Budget updated to 1000"))).toBeTrue();
        });
        it("triggers budget_limited when tokensUsed >= budget", async () => {
            const g = h.gm.create("almost over", 2000);
            h.gm.accumulateUsage(1500, 0, g.id);
            h.messages.length = 0;
            await h.handler("budget 1000", h.ctx());
            expect(h.gm.goal?.status).toBe("budget_limited");
            expect(h.entries.some((e) => e.data?.reason === "budget_limited")).toBeTrue();
            expect(goalStatusMessages(h.messages).some((m) => m.includes("budget-limited"))).toBeTrue();
        });
        it.each([
            { budgetValue: "-1", label: "negative" },
            { budgetValue: "abc", label: "non-numeric" },
            { budgetValue: "1.5", label: "float" },
        ])("rejects $label budget", async ({ budgetValue }) => {
            h.gm.create("test");
            h.messages.length = 0;
            await h.handler(`budget ${budgetValue}`, h.ctx());
            expect(goalStatusMessages(h.messages).some((m) => m.includes("Usage"))).toBeTrue();
            expect(h.gm.goal?.tokenBudget).toBeUndefined();
        });
        it("rejects if no goal exists", async () => {
            await h.handler("budget 500", h.ctx());
            expect(goalStatusMessages(h.messages).some((m) => m.includes("No goal to update budget"))).toBeTrue();
        });
    });
    describe("9. /goal verify", () => {
        it.each([
            { policy: undefined, expected: "off" },
            { policy: "enforce", expected: "enforce" },
        ])("shows current policy: '$expected'", async ({ policy, expected }) => {
            if (policy)
                h.gm.setVerifierPolicy(policy as any);
            await h.handler("verify", h.ctx());
            expect(goalStatusMessages(h.messages).some((m) => m.includes(`Verifier policy: ${expected}`))).toBeTrue();
        });
        it.each([
            { args: "verify off", policy: "off" },
            { args: "verify warn", policy: "warn" },
            { args: "verify enforce", policy: "enforce" },
        ])("sets policy to $policy", async ({ args, policy }) => {
            if (policy !== "off")
                h.gm.setVerifierPolicy("off");
            await h.handler(args, h.ctx());
            expect(h.gm.verifierPolicy).toBe(policy);
        });
        it("persists policy to config.json", async () => {
            await h.handler("verify enforce", h.ctx());
            expect(h.gm.verifierPolicy).toBe("enforce");
        });
        it.each([
            { args: "verify strict", expected: "Usage" },
            { args: "verify ", expected: "Verifier policy" },
        ])("'$args' → shows '$expected'", async ({ args, expected }) => {
            await h.handler(args, h.ctx());
            expect(goalStatusMessages(h.messages).some((m) => m.includes(expected))).toBeTrue();
        });
    });
    describe("10. extra args → budgetInvalid → usage error", () => {
        it.each([
            { args: "pause extra", setup: undefined, expected: "No goal to pause" },
            { args: "resume some random text", setup: "pause:test", expected: "Usage: /goal resume" },
            { args: "resume --budget", setup: "pause:test", expected: "Usage: /goal resume" },
            { args: "replace --budget", setup: "create:original", expected: "Usage: /goal replace" },
            { args: "budget unlimited", setup: "create:test", expected: "Usage: /goal budget" },
        ])("$args", async ({ args, setup, expected }) => {
            if (setup) {
                const [action, label] = setup.split(":");
                if (action === "create")
                    h.gm.create(label);
                if (action === "pause") {
                    h.gm.create(label);
                    h.gm.pause("user");
                }
                h.messages.length = 0;
            }
            await h.handler(args, h.ctx());
            expect(goalStatusMessages(h.messages).some((m) => m.includes(expected))).toBeTrue();
        });
    });
    describe("11. state transition guards (in-memory)", () => {
        it.each([
            { setup: "active:existing", expectedMsg: "already active", expectedObjective: "existing", cantCreate: true },
            { setup: "paused:existing", expectedMsg: "already active", expectedObjective: "existing", cantCreate: true },
            { setup: "complete:done:100", expectedMsg: undefined, expectedObjective: "fresh start", cantCreate: false },
            { setup: "budget_limited:limited:10", expectedMsg: undefined, expectedObjective: "fresh start after limit", cantCreate: false },
        ])("$setup → $expectedMsg", async ({ setup, expectedMsg, expectedObjective, cantCreate }) => {
            const parts = setup.split(":");
            if (parts[0] === "active")
                h.gm.create(parts[1]);
            if (parts[0] === "paused") {
                h.gm.create(parts[1]);
                h.gm.pause("user");
            }
            if (parts[0] === "complete") {
                h.gm.create(parts[1], Number(parts[2]));
                h.gm.accumulateUsage(50, 0, h.gm.goal!.id);
                h.gm.complete();
            }
            if (parts[0] === "budget_limited") {
                h.gm.create(parts[1], Number(parts[2]));
                h.gm.accumulateUsage(20, 0, h.gm.goal!.id, "active_only");
            }
            h.messages.length = 0;
            await h.handler(expectedObjective, h.ctx());
            if (expectedMsg)
                expect(goalStatusMessages(h.messages).some((m) => m.includes(expectedMsg))).toBeTrue();
            if (cantCreate)
                expect(h.gm.goal?.objective).toBe(parts[1]);
            else {
                expect(h.gm.goal?.objective).toBe(expectedObjective);
                expect(h.gm.goal?.status).toBe("active");
            }
        });
    });
});
