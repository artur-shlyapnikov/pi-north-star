import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalManager } from "./goal-manager";
import type { GoalRuntime } from "../runtime/goal-runtime";
import { STALE_ERROR, type GoalServiceErrorCode, type GoalSnapshot, type GoalServiceResult, type VerifierPolicy, } from "./goal-types";
import { persistGoal, writeConfig } from "../persistence/goal-persistence";
import { applyVerifierPolicy } from "../verification/verifier";
import { normalizeAndValidateObjective, validateGoalBudget } from "./validators";
export type { GoalServiceResult } from "./goal-types";
function okResult(extra?: Partial<GoalServiceResult>): GoalServiceResult {
    return { ok: true, level: "info", ...extra };
}
function validationError(message: string): GoalServiceResult {
    return { ok: false, level: "error", error: message, message, code: "validation" };
}
function notFound(level: GoalServiceLevel, message: string): GoalServiceResult {
    return { ok: false, level, error: message, message, code: "not_found" };
}
function conflict(level: GoalServiceLevel, message: string): GoalServiceResult {
    return { ok: false, level, error: message, message, code: "conflict" };
}
function staleError(): GoalServiceResult {
    return { ok: false, level: "error", error: STALE_ERROR, message: STALE_ERROR, code: "stale" };
}
function serviceError(level: GoalServiceLevel, code: GoalServiceErrorCode, message: string, extra?: Partial<GoalServiceResult>): GoalServiceResult {
    return { ok: false, level, error: message, message, code, ...extra };
}
interface GoalServiceCreateInput {
    objective: string;
    budget?: number;
    ctx?: ExtensionContext;
}
interface GoalServiceCompleteInput {
    ctx?: ExtensionContext;
}
interface GoalServiceMutationInput {
    ctx?: ExtensionContext;
}
interface GoalServiceBudgetInput {
    budget?: number;
    ctx?: ExtensionContext;
}
interface GoalServiceResumeInput {
    budget?: number;
    ctx?: ExtensionContext;
}
interface GoalServiceDeps {
    pi: ExtensionAPI;
    gm: GoalManager;
    runtime: GoalRuntime;
    onSyncGoalTools?: () => void;
}
export class GoalService {
    constructor(private readonly deps: GoalServiceDeps) { }
    async createOrReplace(input: GoalServiceCreateInput, reason: "created" | "replaced"): Promise<GoalServiceResult> {
        const objectiveValidation = normalizeAndValidateObjective(input.objective);
        if (objectiveValidation.error)
            return validationError(objectiveValidation.error);
        const budgetValidation = validateGoalBudget(input.budget);
        if (budgetValidation.error)
            return validationError(budgetValidation.error);
        return this.deps.runtime.runGoalMutation(input.ctx, { requestContinuation: true }, async () => {
            if (reason === "created" && this.deps.gm.goal && this.deps.gm.goal.status !== "complete" && this.deps.gm.goal.status !== "budget_limited") {
                return conflict("warning", "A goal is already active or paused. Use /goal replace <text> or /goal clear first.");
            }
            const snap = this.deps.gm.create(objectiveValidation.objective, budgetValidation.value);
            persistGoal(this.deps.pi, snap, reason);
            this.deps.onSyncGoalTools?.();
            return okResult({ goal: snap, remainingTokens: null, completionBudgetReport: null });
        });
    }
    async create(input: GoalServiceCreateInput): Promise<GoalServiceResult> {
        if (this.deps.gm.goal && this.deps.gm.goal.status !== "complete" && this.deps.gm.goal.status !== "budget_limited") {
            return conflict("warning", "A goal is already active or paused. Use /goal replace <text> or /goal clear first.");
        }
        return this.createOrReplace(input, "created");
    }
    async pause(input: GoalServiceMutationInput = {}): Promise<GoalServiceResult> {
        const goal = this.deps.gm.goal;
        if (!goal)
            return notFound("info", "No goal to pause.");
        if (goal.status !== "active")
            return conflict("info", `Goal is already ${goal.status}. No action taken.`);
        const expectedGoalId = this.deps.gm.goal?.id;
        return this.deps.runtime.runGoalMutation(input.ctx, undefined, async () => {
            if (!this.deps.gm.pause("user", expectedGoalId)) {
                return staleError();
            }
            persistGoal(this.deps.pi, this.deps.gm.goal, "paused");
            return okResult({ message: "Goal paused." });
        });
    }
    async resume(input: GoalServiceResumeInput = {}): Promise<GoalServiceResult> {
        const goal = this.deps.gm.goal;
        if (!goal)
            return notFound("info", "No goal to resume.");
        if (goal.status !== "paused")
            return conflict("info", `Goal is ${goal.status}, not paused. No action taken.`);
        const budgetValidation = validateGoalBudget(input.budget);
        if (budgetValidation.error)
            return validationError(budgetValidation.error);
        const expectedGoalId = this.deps.gm.goal?.id;
        return this.deps.runtime.runGoalMutation(input.ctx, { requestContinuation: true }, async () => {
            if (!this.deps.gm.resume(budgetValidation.value, expectedGoalId)) {
                return staleError();
            }
            persistGoal(this.deps.pi, this.deps.gm.goal, "resumed");
            const message = input.budget !== undefined
                ? `Goal resumed with budget ${input.budget}.`
                : "Goal resumed.";
            return okResult({ message });
        });
    }
    async clear(input: GoalServiceMutationInput = {}): Promise<GoalServiceResult> {
        if (!this.deps.gm.goal)
            return notFound("warning", "No goal to clear.");
        const expectedGoalId = this.deps.gm.goal?.id;
        return this.deps.runtime.runGoalMutation(input.ctx, undefined, async () => {
            if (!this.deps.gm.clear(expectedGoalId)) {
                return staleError();
            }
            persistGoal(this.deps.pi, null, "cleared");
            this.deps.onSyncGoalTools?.();
            return okResult({ message: "Goal cleared." });
        });
    }
    async updateBudget(input: GoalServiceBudgetInput): Promise<GoalServiceResult> {
        const budgetValidation = validateGoalBudget(input.budget);
        if (budgetValidation.error)
            return validationError(budgetValidation.error);
        if (!this.deps.gm.goal)
            return notFound("warning", "No goal to update budget.");
        const expectedGoalId = this.deps.gm.goal?.id;
        return this.deps.runtime.runGoalMutation(input.ctx, undefined, async () => {
            const result = this.deps.gm.updateBudget(budgetValidation.value, expectedGoalId);
            if (result === "no_goal") {
                return notFound("warning", "No goal to update budget.");
            }
            if (result === "stale") {
                return staleError();
            }
            if (result === "budget_limited") {
                persistGoal(this.deps.pi, this.deps.gm.goal, "budget_limited");
                const msg = `Budget set to ${input.budget}. Goal budget-limited (tokens used: ${this.deps.gm.goal?.tokensUsed}).`;
                return { ok: false, level: "warning", error: msg, message: msg };
            }
            persistGoal(this.deps.pi, this.deps.gm.goal, "updated");
            return okResult({ message: input.budget !== undefined ? `Budget updated to ${input.budget}.` : "Budget limit removed." });
        });
    }
    async complete(input: GoalServiceCompleteInput = {}): Promise<GoalServiceResult> {
        if (!this.deps.gm.goal || this.deps.gm.goal.status !== "active") {
            return notFound("error", "No active goal to complete.");
        }
        const evidence = this.deps.gm.getTurnEvidence();
        const decision = applyVerifierPolicy(this.deps.gm.verifierPolicy, evidence);
        if (!decision.allow) {
            return serviceError("error", "verifier_blocked", decision.result.message ?? "Goal completion blocked by verifier.", {
                verifierResult: {
                    passed: decision.result.passed,
                    evidenceCount: decision.result.evidenceCount,
                    evidenceSummary: decision.result.evidenceSummary,
                    missing: decision.result.missing,
                },
            });
        }
        const expectedGoalId = this.deps.gm.goal?.id;
        return this.deps.runtime.runGoalMutation(input.ctx, undefined, async () => {
            const successComplete = this.deps.gm.complete(expectedGoalId);
            if (!successComplete) {
                return serviceError("error", "stale", "Cannot complete goal.");
            }
            this.deps.runtime.toolCompletedGoalDone = true;
            persistGoal(this.deps.pi, this.deps.gm.goal, "completed");
            this.deps.onSyncGoalTools?.();
            if (!decision.result.passed) {
                console.warn(`[goal] ${decision.result.message}`);
            }
            const report = {
                tokenBudget: this.deps.gm.goal.tokenBudget,
                tokensUsed: this.deps.gm.goal.tokensUsed,
                timeUsedSeconds: this.deps.gm.goal.timeUsedSeconds,
                withinBudget: this.deps.gm.goal.tokenBudget !== undefined
                    ? this.deps.gm.goal.tokensUsed <= this.deps.gm.goal.tokenBudget
                    : true,
            };
            return okResult({ goal: this.deps.gm.goal, remainingTokens: null, completionBudgetReport: report, terminate: true });
        });
    }
    setVerifierPolicy(policyRaw: string): GoalServiceResult {
        const normalized = policyRaw.trim().toLowerCase() as VerifierPolicy;
        const validPolicies: VerifierPolicy[] = ["off", "warn", "enforce"];
        if (!validPolicies.includes(normalized)) {
            return validationError(`Usage: /goal verify off|warn|enforce (got "${policyRaw}")`);
        }
        this.deps.gm.setVerifierPolicy(normalized);
        writeConfig({ verifierPolicy: normalized });
        const message = normalized === "enforce"
            ? "Verifier policy set to enforce. update_goal will require verification evidence."
            : normalized === "warn"
                ? "Verifier policy set to warn. update_goal will warn on insufficient evidence but allow it."
                : "Verifier policy set to off. update_goal will not verify evidence.";
        return okResult({ message });
    }
    showPlanFileEnabled(): GoalServiceResult {
        const status = this.deps.gm.planFileEnabled ? "on" : "off";
        return okResult({ message: `.goal-plan.md file creation: ${status}` });
    }
    setPlanFileEnabled(enabled: boolean): GoalServiceResult {
        this.deps.gm.planFileEnabled = enabled;
        writeConfig({ planFileEnabled: enabled });
        const msg = enabled
            ? ".goal-plan.md file creation enabled. Model will write plan to file."
            : ".goal-plan.md file creation disabled. Model will not create plan file.";
        return okResult({ message: msg });
    }
}
