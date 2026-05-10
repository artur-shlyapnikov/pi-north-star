// P0 smoke tests — cross-module invariants

import { describe, it, expect } from "bun:test";
import { GoalManager } from "../../src/goal/goal-manager";
import { GoalRuntime } from "../../src/runtime/goal-runtime";
import { makeGoalSnapshot, makeMockApi, makeExtensionContext, drainRuntime, findMessagesByCustomType } from "../fixtures/test-fixtures";
import { persistGoal } from "../../src/persistence/goal-persistence";

describe("P0 smoke", () => {
  it("active goal dispatches continuation", async () => {
    const mock = makeMockApi({ allTools: [] });
    const gm = new GoalManager();
    gm.goal = makeGoalSnapshot({ id: "p0", revision: 1 });
    gm.refreshLiveStatusForGoalState();
    const runtime = new GoalRuntime(mock.api as any, gm);
    persistGoal(mock.api, gm.goal!, "created");
    const ctx = makeExtensionContext({ branchEntries: mock.branchEntries, idle: true });
    runtime.onAgentStart();
    (runtime as any).agentRunning = false;
    runtime.requestContinuation(ctx);
    await drainRuntime(runtime);
    expect(findMessagesByCustomType(mock.messages, "pi.goal.continuation")).toHaveLength(1);
  });

  it("budget-limited goal suppresses continuation", async () => {
    const mock = makeMockApi({ allTools: [] });
    const gm = new GoalManager();
    gm.goal = makeGoalSnapshot({ id: "p0", revision: 1, status: "budget_limited", tokenBudget: 10, tokensUsed: 15 });
    gm.refreshLiveStatusForGoalState();
    const runtime = new GoalRuntime(mock.api as any, gm);
    persistGoal(mock.api, gm.goal!, "created");
    const ctx = makeExtensionContext({ branchEntries: mock.branchEntries, idle: true });
    runtime.onAgentStart();
    (runtime as any).agentRunning = false;
    runtime.requestContinuation(ctx);
    await drainRuntime(runtime);
    expect(findMessagesByCustomType(mock.messages, "pi.goal.continuation")).toHaveLength(0);
  });

  it("update_goal completion terminates", async () => {
    const mock = makeMockApi({ allTools: [], activeTools: [] });
    const gm = new GoalManager();
    gm.create("p0 test");
    const runtime = new GoalRuntime(mock.api as any, gm);
    (runtime as any).lastContext = makeExtensionContext({ idle: true });
    const { registerGoalTools } = await import("../../src/tools/register-goal-tools");
    registerGoalTools(mock.api as any, gm, runtime);
    const result = await mock.tools.find((t: any) => t.name === "update_goal")!.execute(
      "call-1", { status: "complete" },
      undefined, makeExtensionContext({ idle: true }),
    );
    expect(result).toHaveProperty("terminate", true);
    expect(gm.goal!.status).toBe("complete");
  });
});
