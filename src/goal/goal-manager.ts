import type { SessionEntry, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { accountTokenDelta } from "../runtime/accounting";
import { loadGoalFromEntries } from "../persistence/goal-persistence";
import { READ_TOOLS, VERIFY_HINTS, WRITE_TOOLS, type AccountingMode, type EvidenceItem, type GoalConfig, type GoalPauseReason, type GoalSnapshot, type TokenUsageSnapshot, type VerifierPolicy, } from "./goal-types";
import { collectEvidenceFromToolResults } from "../verification/verifier";
type GoalLivePhase = "planning" | "executing" | "verifying" | "blocked";
export const GOAL_TOOLS = new Set(["get_goal", "update_goal", "clear_goal"]);
const READ_ONLY_TOOLS = new Set([
    ...READ_TOOLS,
    "get_goal",
    "web_search",
    "code_search",
    "fetch_content",
    "get_search_content",
]);
const EXECUTION_TOOLS = WRITE_TOOLS;
export class GoalManager {
    goal: GoalSnapshot | null = null;
    planFileEnabled = true;
    verifierPolicy: VerifierPolicy = "off";
    turnEvidence: EvidenceItem[] = [];
    livePhase: GoalLivePhase | null = null;
    private _completionAccountingDone = true;
    _turnAccountingBaseline: TokenUsageSnapshot | null = null;
    private touch(timestamp?: string): void {
        if (!this.goal)
            return;
        this.goal.updatedAt = timestamp ?? new Date().toISOString();
    }
    private finishMutation(options?: {
        refreshLive?: boolean;
        timestamp?: string;
    }): void {
        this.touch(options?.timestamp);
        if (this.goal)
            this.goal.revision++;
        if (options?.refreshLive !== false)
            this.refreshLiveStatusForGoalState();
    }
    private isOverBudget(): boolean {
        return !!this.goal && this.goal.tokenBudget !== undefined && this.goal.tokensUsed >= this.goal.tokenBudget;
    }
    computeAndAdvanceBaseline(current: TokenUsageSnapshot): number {
        let delta: number;
        if (this._turnAccountingBaseline === null) {
            delta = accountTokenDelta(current);
        }
        else {
            const b = this._turnAccountingBaseline;
            const inputDelta = Math.max(0, current.input - b.input);
            const cachedDelta = Math.max(0, current.cachedInput - b.cachedInput);
            const outputDelta = Math.max(0, current.output - b.output);
            delta = Math.max(0, inputDelta - cachedDelta) + outputDelta;
        }
        this._turnAccountingBaseline = current;
        return delta;
    }
    rebuildFromEntries(entries: SessionEntry[]): void {
        this.goal = loadGoalFromEntries(entries);
        this.turnEvidence = [];
        this._completionAccountingDone = true;
        this._turnAccountingBaseline = null;
        this.refreshLiveStatusForGoalState();
    }
    applyConfig(config: GoalConfig): void {
        this.planFileEnabled = config.planFileEnabled;
        this.verifierPolicy = config.verifierPolicy;
    }
    verifyExpectedGoalPrecondition(expected: {
        id: string;
        revision: number;
    } | undefined, actual: GoalSnapshot | null): boolean {
        if (expected === undefined)
            return true;
        if (actual === null)
            return false;
        return actual.id === expected.id && actual.revision === expected.revision;
    }
    private verifyExpectedGoalId(expectedGoalId: string | undefined): boolean {
        if (expectedGoalId === undefined)
            return true;
        return !!this.goal && this.goal.id === expectedGoalId;
    }
    private buildSnapshot(objective: string, tokenBudget?: number): GoalSnapshot {
        const now = new Date().toISOString();
        return {
            schemaVersion: 1,
            id: crypto.randomUUID(),
            revision: 1,
            objective,
            status: "active",
            tokenBudget,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: now,
            updatedAt: now,
            continuationSequence: 0,
        };
    }
    refreshLiveStatusForGoalState(): void {
        if (!this.goal) {
            this.livePhase = null;
            return;
        }
        if (this.goal.status === "active") {
            if (!this.livePhase)
                this.livePhase = "planning";
            return;
        }
        if (this.goal.status === "complete") {
            this.livePhase = "verifying";
            return;
        }
        this.livePhase = "blocked";
    }
    complete(expectedGoalId?: string): boolean {
        if (!this.goal || this.goal.status !== "active" || !this.verifyExpectedGoalId(expectedGoalId))
            return false;
        const now = new Date().toISOString();
        this.goal!.status = "complete";
        this.goal!.pauseReason = undefined;
        this.goal!.completedAt = now;
        this.finishMutation({ timestamp: now });
        this._completionAccountingDone = false;
        this.turnEvidence = [];
        return true;
    }
    pause(reason: GoalPauseReason, expectedGoalId?: string): boolean {
        if (!this.goal || this.goal.status !== "active" || !this.verifyExpectedGoalId(expectedGoalId))
            return false;
        this.goal!.status = "paused";
        this.goal!.pauseReason = reason;
        this.finishMutation();
        return true;
    }
    resume(tokenBudget?: number, expectedGoalId?: string): boolean {
        if (!this.goal || this.goal.status !== "paused" || !this.verifyExpectedGoalId(expectedGoalId))
            return false;
        this.goal.status = "active";
        this.goal.pauseReason = undefined;
        if (tokenBudget !== undefined)
            this.goal.tokenBudget = tokenBudget;
        this.finishMutation({ refreshLive: false });
        this.livePhase = "executing";
        return true;
    }
    markBudgetLimited(expectedGoalId?: string): boolean {
        if (!this.goal || !this.verifyExpectedGoalId(expectedGoalId))
            return false;
        this.goal.status = "budget_limited";
        this.finishMutation();
        return true;
    }
    updateBudget(tokenBudget: number | undefined, expectedGoalId?: string): "updated" | "budget_limited" | "no_goal" | "stale" {
        if (!this.goal || !this.verifyExpectedGoalId(expectedGoalId))
            return this.goal ? "stale" : "no_goal";
        this.goal.tokenBudget = tokenBudget;
        if (tokenBudget !== undefined && this.isOverBudget() && (this.goal.status === "active" || this.goal.status === "budget_limited")) {
            this.markBudgetLimited();
            return "budget_limited";
        }
        if (this.goal.status === "budget_limited") {
            this.goal.status = "active";
            this.livePhase = "planning";
        }
        this.finishMutation();
        return "updated";
    }
    accumulateUsage(tokens: number, timeSec: number, expectedGoalId?: string, mode: AccountingMode = "active_or_complete"): boolean {
        if (!this.goal || !this.verifyExpectedGoalId(expectedGoalId))
            return false;
        const status = this.goal.status;
        switch (mode) {
            case "active_only":
                if (status !== "active" && status !== "budget_limited")
                    return false;
                break;
            case "active_or_complete":
                if (status === "paused")
                    return false;
                if (status === "complete") {
                    if (this._completionAccountingDone)
                        return false;
                    this._completionAccountingDone = true;
                }
                break;
        }
        if (tokens > 0)
            this.goal.tokensUsed += tokens;
        if (timeSec > 0)
            this.goal.timeUsedSeconds += timeSec;
        this.touch();
        if (this.goal.status === "active" && this.isOverBudget()) {
            this.markBudgetLimited(expectedGoalId);
            return true;
        }
        return false;
    }
    incrementSequence(): number {
        if (!this.goal)
            return 0;
        this.goal.continuationSequence++;
        this.finishMutation({ refreshLive: false });
        return this.goal.continuationSequence;
    }
    clear(expectedGoalId?: string): boolean {
        if (!this.verifyExpectedGoalId(expectedGoalId))
            return false;
        this.goal = null;
        this._turnAccountingBaseline = null;
        this._completionAccountingDone = true;
        this.turnEvidence = [];
        this.refreshLiveStatusForGoalState();
        return true;
    }
    create(objective: string, tokenBudget?: number): GoalSnapshot {
        this._turnAccountingBaseline = null;
        this._completionAccountingDone = true;
        const snap = this.buildSnapshot(objective, tokenBudget);
        if (tokenBudget !== undefined && snap.tokensUsed >= tokenBudget) {
            snap.status = "budget_limited";
        }
        this.goal = snap;
        this.livePhase = snap.status === "budget_limited" ? "blocked" : "planning";
        this.turnEvidence = [];
        return snap;
    }
    getExpectedGoalPrecondition(): {
        id: string;
        revision: number;
    } | undefined {
        return this.goal ? { id: this.goal.id, revision: this.goal.revision } : undefined;
    }
    getTurnEvidence(): EvidenceItem[] {
        return [...this.turnEvidence];
    }
    setVerifierPolicy(policy: VerifierPolicy): void {
        this.verifierPolicy = policy;
    }
    getVerifierPolicy(): VerifierPolicy {
        return this.verifierPolicy;
    }
    recordTurnEvidence(toolResults: {
        toolName: string;
        isError?: boolean;
    }[]): void {
        const newEvidence = collectEvidenceFromToolResults(toolResults);
        if (newEvidence.length === 0)
            return;
        this.turnEvidence = [...this.turnEvidence, ...newEvidence];
    }
    updateLiveFromTurn(event: TurnEndEvent): void {
        if (!this.goal || this.goal.status !== "active")
            return;
        const results = event.toolResults ?? [];
        const successes = results.filter((r) => !r.isError);
        const tools = successes.filter((r) => !GOAL_TOOLS.has(r.toolName)).map((r) => r.toolName);
        if (tools.length === 0 && results.some((r) => r.isError)) {
            this.livePhase = "blocked";
        }
        else if (tools.some((n) => VERIFY_HINTS.some((h) => n.toLowerCase().includes(h)))) {
            this.livePhase = "verifying";
        }
        else if (tools.some((n) => EXECUTION_TOOLS.has(n))) {
            this.livePhase = "executing";
        }
        else if (tools.length > 0 && tools.every((n) => READ_ONLY_TOOLS.has(n))) {
            this.livePhase = "planning";
        }
        else if (tools.length > 0) {
            this.livePhase = "executing";
        }
        else {
            this.livePhase = "planning";
        }
    }
}
