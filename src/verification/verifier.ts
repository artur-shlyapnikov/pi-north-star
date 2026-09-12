import { READ_TOOLS, VERIFY_HINTS, WRITE_TOOLS, type EvidenceItem, type EvidenceKind, type VerificationResult, type VerifierPolicy } from "../goal/goal-types";
export const GOAL_TOOLS = new Set(["get_goal", "update_goal", "clear_goal"]);
const OBSERVE_TOOLS = new Set(["web_search", "code_search", "fetch_content", "get_search_content"]);
export type ToolClass = "goal" | "read" | "write" | "verify" | "command" | "observe" | "other";
export function classifyTool(toolName: string): ToolClass {
    if (GOAL_TOOLS.has(toolName))
        return "goal";
    if (READ_TOOLS.has(toolName))
        return "read";
    if (WRITE_TOOLS.has(toolName))
        return "write";
    if (VERIFY_HINTS.some((hint) => toolName.toLowerCase().includes(hint)))
        return "verify";
    if (toolName === "bash" || toolName === "shell")
        return "command";
    if (OBSERVE_TOOLS.has(toolName))
        return "observe";
    return "other";
}
export type GoalLivePhase = "planning" | "executing" | "verifying" | "blocked";
export function deriveLivePhase(toolResults: {
    toolName: string;
    isError?: boolean;
}[]): GoalLivePhase {
    const tools = toolResults.filter((r) => !r.isError && classifyTool(r.toolName) !== "goal").map((r) => r.toolName);
    if (tools.length === 0 && toolResults.some((r) => r.isError))
        return "blocked";
    if (tools.some((n) => classifyTool(n) === "verify"))
        return "verifying";
    if (tools.some((n) => classifyTool(n) === "write"))
        return "executing";
    if (tools.length > 0 && tools.every((n) => classifyTool(n) === "read" || classifyTool(n) === "observe"))
        return "planning";
    if (tools.length > 0)
        return "executing";
    return "planning";
}
function classifyToolResult(toolName: string, isError: boolean): {
    kind: EvidenceKind;
    summary: string;
} | null {
    if (isError)
        return null;
    switch (classifyTool(toolName)) {
        case "goal":
            return toolName === "get_goal" ? { kind: "goal_check", summary: "checked active goal via get_goal" } : null;
        case "read":
            return { kind: "file_inspection", summary: `inspected files via ${toolName}` };
        case "write":
            return { kind: "file_change", summary: `modified files via ${toolName}` };
        case "verify":
            return { kind: "test_run", summary: `ran verification: ${toolName}` };
        case "command":
            return { kind: "command_output", summary: `executed command via bash` };
        case "observe":
        case "other":
            return { kind: "verification_tool", summary: `used tool: ${toolName}` };
    }
}
export function collectEvidenceFromToolResults(toolResults: {
    toolName: string;
    isError?: boolean;
}[]): EvidenceItem[] {
    const items: EvidenceItem[] = [];
    const seen = new Set<string>();
    for (const r of toolResults) {
        const classified = classifyToolResult(r.toolName, r.isError ?? false);
        if (!classified)
            continue;
        const dedupKey = classified.kind;
        if (seen.has(dedupKey))
            continue;
        seen.add(dedupKey);
        items.push({
            kind: classified.kind,
            toolName: r.toolName,
            summary: classified.summary,
            timestamp: new Date().toISOString(),
        });
    }
    return items;
}
export function checkEvidence(evidence: EvidenceItem[]): VerificationResult {
    const evidenceSummary: string[] = [];
    const missing: string[] = [];
    if (evidence.length === 0) {
        return {
            passed: false,
            evidenceCount: 0,
            evidenceSummary: [],
            missing: ["No verification evidence found in this turn. The model must use tools to inspect or modify the codebase before claiming completion."],
            message: "No tool evidence in this turn — use tools to verify before calling update_goal.",
        };
    }
    const byKind = new Map<EvidenceKind, EvidenceItem[]>();
    for (const item of evidence) {
        const arr = byKind.get(item.kind) ?? [];
        arr.push(item);
        byKind.set(item.kind, arr);
    }
    for (const [kind, items] of byKind) {
        evidenceSummary.push(`${kind}: ${items.length} item(s) — ${items.map((i) => i.summary).join(", ")}`);
    }
    if (byKind.size < 2) {
        missing.push("Evidence is too narrow. Provide at least 2 distinct evidence kinds (for example: file_change + test_run, or file_inspection + command_output).");
    }
    const hasChange = byKind.has("file_change");
    const hasTest = byKind.has("test_run");
    const hasCommand = byKind.has("command_output");
    const hasVerificationTool = byKind.has("verification_tool");
    if (!hasChange && !hasTest && !hasCommand && !hasVerificationTool) {
        missing.push("No execution, test, or command-output evidence — only file inspection. Cannot confirm completion without concrete verification.");
    }
    if (!hasChange && !hasTest) {
        missing.push("No file changes or test results. The goal likely requires code changes or verification tests.");
    }
    const passed = missing.length === 0;
    return {
        passed,
        evidenceCount: evidence.length,
        evidenceSummary,
        missing,
        message: passed
            ? "Sufficient verification evidence collected."
            : `Missing evidence: ${missing.join("; ")}`,
    };
}
export interface VerifierDecision {
    allow: boolean;
    result: VerificationResult;
}
export function applyVerifierPolicy(policy: VerifierPolicy, evidence: EvidenceItem[]): VerifierDecision {
    if (policy === "off") {
        return {
            allow: true,
            result: {
                passed: true,
                evidenceCount: evidence.length,
                evidenceSummary: [],
                missing: [],
                message: "Verifier disabled (policy=off).",
            },
        };
    }
    const result = checkEvidence(evidence);
    if (policy === "warn") {
        return {
            allow: true,
            result: {
                ...result,
                message: result.passed
                    ? "Verification passed."
                    : `[VERIFIER WARN] ${result.message} — proceeding anyway (policy=warn).`,
            },
        };
    }
    if (!result.passed) {
        return {
            allow: false,
            result: {
                ...result,
                message: `[VERIFIER BLOCKED] ${result.message} — call update_goal only after collecting concrete verification evidence.`,
            },
        };
    }
    return { allow: true, result };
}
