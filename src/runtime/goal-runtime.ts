import type { AgentEndEvent, ExtensionAPI, ExtensionContext, TurnEndEvent, } from "@earendil-works/pi-coding-agent";
import { type AccountingMode, type GoalChangeReason, type TokenUsageSnapshot, } from "../goal/goal-types";
import { renderBudgetLimitPrompt, renderContinuationPrompt } from "../presentation/continuation-template";
import { GoalManager, GOAL_TOOLS } from "../goal/goal-manager";
import { applyStatusLine } from "../presentation/status-line";
import { loadGoalFromBranch, persistGoal } from "../persistence/goal-persistence";
import { AsyncMutex } from "./async-mutex";
import { parseTokenUsage, readMessageUsage, WallClock } from "./accounting";
export class GoalRuntime {
    private agentRunning = false;
    private wallClock = new WallClock();
    private dispatchScheduled = false;
    private budgetSteeringSentForGoalId: string | null = null;
    private lastContext: ExtensionContext | null = null;
    private continuationTriggerPending = false;
    private continuationTurnActive = false;
    private continuationToolCount = 0;
    toolCompletedGoalDone = false;
    private readonly goalMutex = new AsyncMutex();
    lifecycleTail: Promise<void> = Promise.resolve();
    private async waitForLifecycleDrain(): Promise<void> {
        await this.lifecycleTail;
    }
    private queueLifecycle(task: () => Promise<void> | void): void {
        this.lifecycleTail = this.lifecycleTail
            .then(() => this.goalMutex.runExclusive(async () => {
            await task();
        }))
            .catch((err: unknown) => {
            console.error("[goal] lifecycle queue error", err);
        });
    }
    constructor(private readonly pi: ExtensionAPI, private readonly gm: GoalManager) { }
    async runGoalMutation<T>(ctx: ExtensionContext | undefined, options: {
        requestContinuation?: boolean;
    } | undefined, fn: () => Promise<T> | T): Promise<T> {
        return this.goalMutex.runExclusive(async () => {
            this.lastContext = ctx ?? this.lastContext;
            this.flushTurnTimeOnly();
            if (ctx && ctx.ui)
                applyStatusLine(ctx, this.gm);
            const result = await fn();
            this.syncWallClock();
            this.syncBudgetSteeringMarker();
            this.maybeSteerBudgetLimit();
            if (this.lastContext && this.lastContext.ui)
                applyStatusLine(this.lastContext, this.gm);
            if (options?.requestContinuation)
                this.requestContinuation(this.lastContext);
            return result;
        });
    }
    private syncWallClock(): void {
        const active = this.gm.goal && (this.gm.goal.status === "active" || this.gm.goal.status === "budget_limited");
        if (active) {
            this.wallClock.markActiveGoal(this.gm.goal.id);
        }
        else {
            this.wallClock.clearActiveGoal();
        }
    }
    private consumeElapsedSeconds(): number {
        if (this.wallClock.lastAccountedAt === null)
            return 0;
        const timeSec = Math.max(0, Math.round((performance.now() - this.wallClock.lastAccountedAt) / 1000));
        if (timeSec > 0) {
            this.wallClock.lastAccountedAt += timeSec * 1000;
        }
        return timeSec;
    }
    onAgentStart(): void {
        this.continuationTurnActive = this.continuationTriggerPending;
        this.continuationTriggerPending = false;
        this.agentRunning = true;
        this.continuationToolCount = 0;
        this.toolCompletedGoalDone = false;
    }
    onTurnStart(): void {
        this.syncWallClock();
        this.gm._turnAccountingBaseline = null;
    }
    onTurnEnd(event: TurnEndEvent, ctx: ExtensionContext): void {
        this.lastContext = ctx;
        const toolResults = event.toolResults ?? [];
        const usage = parseTokenUsage(readMessageUsage(event.message));
        this.queueLifecycle(async () => {
            await this.processTurnEnd(event, ctx, toolResults, usage);
        });
    }
    private async processTurnEnd(event: TurnEndEvent, ctx: ExtensionContext, toolResults: {
        toolName: string;
        isError?: boolean;
    }[], usage: TokenUsageSnapshot | null): Promise<void> {
        this.gm.recordTurnEvidence(toolResults);
        const isCompletionTurn = this.toolCompletedGoalDone ||
            toolResults.some((r) => r.toolName === "update_goal" && !r.isError);
        if (isCompletionTurn)
            this.toolCompletedGoalDone = false;
        const timeSec = this.consumeElapsedSeconds();
        this.accountThreadGoalProgress(usage, timeSec, "active_or_complete", isCompletionTurn);
        this.gm.updateLiveFromTurn(event);
        applyStatusLine(ctx, this.gm);
        this.continuationToolCount += toolResults.filter((r) => !GOAL_TOOLS.has(r.toolName)).length;
    }
    onAgentEnd(_event: AgentEndEvent, ctx: ExtensionContext): void {
        this.lastContext = ctx;
        this.agentRunning = false;
        this.queueLifecycle(async () => {
            await this.processAgentEnd(ctx);
        });
    }
    private async processAgentEnd(ctx: ExtensionContext): Promise<void> {
        if (ctx?.signal?.aborted === true && this.gm.goal?.status === "active"
            && this.wallClock.activeGoalId !== null) {
            this.handleAbortPause(ctx);
        }
        this.syncBudgetSteeringMarker();
        applyStatusLine(ctx, this.gm);
        if (ctx?.signal?.aborted !== true) {
            this.maybeRequestContinuationAfterAgentEnd();
        }
    }
    private handleAbortPause(ctx: ExtensionContext): void {
        const timeSec = this.consumeElapsedSeconds();
        this.accountThreadGoalProgress(null, timeSec, "active_only", false);
        this.gm.pause("abort");
        persistGoal(this.pi, this.gm.goal, "paused");
    }
    private maybeRequestContinuationAfterAgentEnd(): void {
        const stalled = this.continuationTurnActive && this.continuationToolCount === 0;
        if (!stalled)
            this.requestContinuation();
    }
    onSessionShutdown(ctx: ExtensionContext): void {
        this.lastContext = ctx;
        this.syncBudgetSteeringMarker();
        applyStatusLine(ctx, this.gm);
    }
    requestContinuation(ctx?: ExtensionContext): void {
        this.lastContext = ctx ?? this.lastContext;
        if (!this.gm.goal || this.gm.goal.status !== "active")
            return;
        if (this.agentRunning)
            return;
        if (this.continuationTriggerPending)
            return;
        if (this.dispatchScheduled)
            return;
        if (!this.isContextIdle(ctx ?? this.lastContext))
            return;
        this.dispatchScheduled = true;
        void Promise.resolve().then(() => this.dispatchContinuation(ctx ?? this.lastContext));
    }
    private async dispatchContinuation(ctx?: ExtensionContext): Promise<void> {
        try {
            await this.waitForLifecycleDrain();
            await this.goalMutex.runExclusive(async () => {
                const ctxResolved = ctx ?? this.lastContext;
                if (this.continuationTriggerPending)
                    return;
                if (ctxResolved) {
                    const persisted = loadGoalFromBranch(ctxResolved);
                    const precond = this.gm.goal ? { id: this.gm.goal.id, revision: this.gm.goal.revision } : undefined;
                    if (!this.gm.verifyExpectedGoalPrecondition(precond, persisted) || !persisted || persisted.status !== "active") {
                        this.gm.goal = persisted;
                        this.syncWallClock();
                        applyStatusLine(ctxResolved, this.gm);
                        return;
                    }
                }
                const goal = this.gm.goal;
                if (!goal || this.agentRunning || !this.isContextIdle(ctxResolved))
                    return;
                this.gm.incrementSequence();
                persistGoal(this.pi, goal, "usage");
                this.continuationTriggerPending = true;
                this.pi.sendMessage({
                    customType: "pi.goal.continuation",
                    content: renderContinuationPrompt(goal, this.gm.planFileEnabled),
                    display: false,
                    details: {
                        goalId: goal.id,
                        sequence: goal.continuationSequence,
                        synthetic: true,
                    },
                }, { triggerTurn: true });
            });
        }
        finally {
            this.dispatchScheduled = false;
        }
    }
    private flushTurnTimeOnly(): void {
        if (!this.gm.goal || this.wallClock.activeGoalId === null)
            return;
        const timeSec = this.consumeElapsedSeconds();
        this.accountThreadGoalProgress(null, timeSec, "active_only", false);
    }
    private accountThreadGoalProgress(usage: TokenUsageSnapshot | null, timeSec: number, mode: AccountingMode, suppressSteering: boolean): void {
        const goalBefore = this.gm.goal;
        if (!goalBefore)
            return;
        let tokens = 0;
        if (usage !== null) {
            tokens = this.gm.computeAndAdvanceBaseline(usage);
        }
        if (tokens <= 0 && timeSec <= 0)
            return;
        const before = {
            status: goalBefore.status,
            tokensUsed: goalBefore.tokensUsed,
            timeUsedSeconds: goalBefore.timeUsedSeconds,
            revision: goalBefore.revision,
            updatedAt: goalBefore.updatedAt,
        };
        this.gm.accumulateUsage(tokens, timeSec, this.gm.goal?.id, mode);
        const goalAfter = this.gm.goal;
        if (!goalAfter)
            return;
        const changed = goalAfter.status !== before.status ||
            goalAfter.tokensUsed !== before.tokensUsed ||
            goalAfter.timeUsedSeconds !== before.timeUsedSeconds ||
            goalAfter.revision !== before.revision ||
            goalAfter.updatedAt !== before.updatedAt;
        if (!changed)
            return;
        this.persistUsageUpdate(suppressSteering);
    }
    private persistReason(): GoalChangeReason {
        if (!this.gm.goal)
            return "usage";
        switch (this.gm.goal.status) {
            case "complete": return "completed";
            case "budget_limited": return "budget_limited";
            case "paused": return "paused";
            default: return "usage";
        }
    }
    private persistUsageUpdate(suppressBudgetSteering = false): void {
        if (!this.gm.goal)
            return;
        persistGoal(this.pi, this.gm.goal, this.persistReason());
        if (this.gm.goal.status === "budget_limited" && !suppressBudgetSteering) {
            this.maybeSteerBudgetLimit();
        }
    }
    private maybeSteerBudgetLimit(): void {
        if (!this.gm.goal || this.gm.goal.status !== "budget_limited")
            return;
        if (!this.agentRunning)
            return;
        const goalId = this.gm.goal.id;
        if (this.budgetSteeringSentForGoalId === goalId)
            return;
        this.pi.sendMessage({
            customType: "pi.goal.budget_limit",
            content: renderBudgetLimitPrompt(this.gm.goal),
            display: false,
            details: { goalId, synthetic: true },
        }, { triggerTurn: false, deliverAs: "steer" });
        this.budgetSteeringSentForGoalId = goalId;
    }
    private syncBudgetSteeringMarker(): void {
        if (!this.gm.goal || this.gm.goal.status !== "budget_limited") {
            this.budgetSteeringSentForGoalId = null;
        }
    }
    private isContextIdle(ctx?: ExtensionContext): boolean {
        if (!ctx)
            return true;
        if (ctx.hasPendingMessages())
            return false;
        if (!ctx.isIdle())
            return false;
        return true;
    }
}
