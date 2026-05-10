import { describe, it, expect } from "bun:test";
import { renderContinuationPrompt, renderBudgetLimitPrompt, } from "../../src/presentation/continuation-template";
import type { GoalSnapshot } from "../../src/goal/goal-types";
function makeGoal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
    return {
        schemaVersion: 1,
        id: "goal-001",
        revision: 1,
        objective: "Implement the feature",
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        continuationSequence: 1,
        ...overrides,
    };
}
describe("escapeXmlText", () => {
    it.each([
        { objective: "Fish & chips", expect: "&amp;", not: "& chips" },
        { objective: "Use <input>", expect: "&lt;input&gt;" },
        { objective: "x > 0", expect: "x &gt; 0" },
        { objective: "a & b < c > d", expect: "a &amp; b &lt; c &gt; d" },
        { objective: "Fish &amp; chips", expect: "Fish &amp;amp; chips" },
    ])("escapes '$objective' → contains '$expect'", ({ objective, expect: exp, not }) => {
        const output = renderContinuationPrompt(makeGoal({ objective }));
        expect(output).toContain(exp);
        if (not)
            expect(output).not.toContain(not);
    });
});
describe("renderContinuationPrompt", () => {
    it("escapes objective inside <untrusted_objective> tags", () => {
        const output = renderContinuationPrompt(makeGoal({ objective: "Build <widget>" }));
        expect(output).toContain("<untrusted_objective>");
        expect(output).toContain("&lt;widget&gt;");
        expect(output).toContain("</untrusted_objective>");
    });
    it.each([
        { budget: undefined, used: 0, expectedBudget: "none", expectedRemaining: "unbounded" },
        { budget: 100, used: 30, expectedBudget: "100", expectedRemaining: "70" },
        { budget: 100, used: 150, expectedBudget: "100", expectedRemaining: "0", notNegative: true },
    ])("budget=$budget used=$used → $expectedRemaining remaining", ({ budget, used, expectedBudget, expectedRemaining, notNegative }) => {
        const output = renderContinuationPrompt(makeGoal({ tokenBudget: budget, tokensUsed: used }));
        expect(output).toContain(`Token budget: ${expectedBudget}`);
        expect(output).toContain(`Tokens remaining: ${expectedRemaining}`);
        if (notNegative)
            expect(output).not.toContain("-50");
    });
    it("contains full Budget section with time, used, budget, remaining", () => {
        const output = renderContinuationPrompt(makeGoal({ timeUsedSeconds: 45, tokensUsed: 1200, tokenBudget: 5000 }));
        expect(output).toContain("Time spent pursuing goal: 45 seconds");
        expect(output).toContain("Tokens used: 1200");
        expect(output).toContain("Token budget: 5000");
        expect(output).toContain("Tokens remaining: 3800");
    });
    it("contains planning / execution phases and completion instructions", () => {
        const output = renderContinuationPrompt(makeGoal());
        expect(output).toContain("── Planning phase ──");
        expect(output).toContain("── Execution phase ──");
        expect(output).toContain("perform a completion audit");
        expect(output).toContain("Do not call update_goal unless the goal is complete.");
    });
    it("does NOT contain budget_limited or Wrap up", () => {
        const output = renderContinuationPrompt(makeGoal());
        expect(output).not.toContain("budget_limited");
        expect(output).not.toContain("Wrap up");
    });
    it("planFileEnabled=true (default) includes .goal-plan.md instructions", () => {
        const output = renderContinuationPrompt(makeGoal());
        expect(output).toContain(".goal-plan.md");
        expect(output).toContain("write the plan to a file named .goal-plan.md");
        expect(output).toContain("If you already have a plan in .goal-plan.md");
    });
    it("planFileEnabled=false excludes .goal-plan.md instructions", () => {
        const output = renderContinuationPrompt(makeGoal(), false);
        expect(output).not.toContain(".goal-plan.md");
        expect(output).toContain("Then start executing the deliverables");
    });
    it("planFileEnabled=false keeps planning and execution phases", () => {
        const output = renderContinuationPrompt(makeGoal(), false);
        expect(output).toContain("── Planning phase ──");
        expect(output).toContain("── Execution phase ──");
        expect(output).toContain("perform a completion audit");
    });
});
describe("renderBudgetLimitPrompt", () => {
    it("escapes objective inside <untrusted_objective> tags", () => {
        const output = renderBudgetLimitPrompt(makeGoal({ objective: "Fix <bug>" }));
        expect(output).toContain("<untrusted_objective>");
        expect(output).toContain("&lt;bug&gt;");
        expect(output).toContain("</untrusted_objective>");
    });
    it("contains budget values", () => {
        const output = renderBudgetLimitPrompt(makeGoal({ tokenBudget: 2000, tokensUsed: 500 }));
        expect(output).toContain("Token budget: 2000");
        expect(output).toContain("Tokens used: 500");
    });
    it("contains budget-limit content: message, marker, instructions", () => {
        const output = renderBudgetLimitPrompt(makeGoal());
        expect(output).toContain("The active thread goal has reached its token budget.");
        expect(output).toContain("The system has marked the goal as budget_limited");
        expect(output).toContain("do not start new substantive work");
        expect(output).toContain("Wrap up this turn soon");
        expect(output).toContain("Do not call update_goal unless the goal is actually complete.");
    });
    it("does NOT contain Planning phase or Execution phase", () => {
        const output = renderBudgetLimitPrompt(makeGoal());
        expect(output).not.toContain("Planning phase");
        expect(output).not.toContain("Execution phase");
    });
});
