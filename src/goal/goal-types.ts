export type GoalPauseReason = "user" | "abort" | "no_progress" | "error" | "session_replaced";
export type GoalChangeReason = "created" | "replaced" | "updated" | "usage" | "paused" | "resumed" | "completed" | "budget_limited" | "cleared";
export interface GoalSnapshot {
    schemaVersion: 1;
    id: string;
    revision: number;
    objective: string;
    status: "active" | "paused" | "complete" | "budget_limited";
    pauseReason?: GoalPauseReason;
    tokenBudget?: number;
    tokensUsed: number;
    timeUsedSeconds: number;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    continuationSequence: number;
}
export interface CompletionBudgetReport {
    tokenBudget?: number;
    tokensUsed: number;
    timeUsedSeconds: number;
    withinBudget: boolean;
}
export const SNAPSHOT_CUSTOM_TYPE = "goal.snapshot" as const;
export const VERIFIER_CUSTOM_TYPE = "goal.verifier" as const;
export const GOAL_EVENT_CUSTOM_TYPE = "goal.event" as const;
export const STALE_ERROR = "Goal was replaced or changed since read; call get_goal and retry.";
export const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
export const WRITE_TOOLS = new Set(["edit", "write"]);
export const VERIFY_HINTS = ["test", "verify", "build", "lint", "typecheck"];
export type AccountingMode = "active_only" | "active_or_complete";
export interface TokenUsageSnapshot {
    input: number;
    cachedInput: number;
    output: number;
}
export type VerifierPolicy = "off" | "warn" | "enforce";
export interface GoalConfig {
    planFileEnabled: boolean;
    verifierPolicy: VerifierPolicy;
}
export interface EvidenceItem {
    kind: EvidenceKind;
    toolName: string;
    summary: string;
    timestamp: string;
}
export type EvidenceKind = "file_inspection" | "file_change" | "test_run" | "command_output" | "verification_tool" | "goal_check";
export interface VerificationResult {
    passed: boolean;
    evidenceCount: number;
    evidenceSummary: string[];
    missing: string[];
    message?: string;
}
export type GoalServiceLevel = "info" | "warning" | "error";
export type GoalServiceVerifierResult = VerificationResult;
export type GoalServiceErrorCode = "validation" | "not_found" | "conflict" | "stale" | "verifier_blocked";
export interface GoalServiceResult {
    ok: boolean;
    level: GoalServiceLevel;
    code?: GoalServiceErrorCode;
    message?: string;
    error?: string;
    goal?: GoalSnapshot | null;
    remainingTokens?: number | null;
    completionBudgetReport?: CompletionBudgetReport | null;
    verifierResult?: GoalServiceVerifierResult;
    terminate?: boolean;
}
export interface AppendedEntry {
    type: string;
    data: unknown;
}
export interface CapturedMessage {
    msg: unknown;
    opts?: unknown;
}
export interface ToolTextContent {
    type: "text";
    text: string;
}
