import { describe, it, expect, beforeEach } from "bun:test";
import { collectEvidenceFromToolResults, checkEvidence, applyVerifierPolicy, } from "../../src/verification/verifier";
import type { EvidenceItem } from "../../src/goal/goal-types";
function isoNow(): string {
    return new Date().toISOString();
}
function makeEvidence(kind: string, toolName = "test_tool"): EvidenceItem {
    return { kind: kind as any, toolName, summary: `${kind} via ${toolName}`, timestamp: isoNow() };
}
describe("classifyToolResult via collectEvidenceFromToolResults", () => {
    it("isError=true → null (any tool)", () => {
        const tools = ["get_goal", "read", "edit", "bash", "grep", "test"];
        for (const tool of tools) {
            const evidence = collectEvidenceFromToolResults([{ toolName: tool, isError: true }]);
            expect(evidence).toHaveLength(0, `isError=true should yield no evidence for ${tool}`);
        }
    });
    it('"get_goal" → "goal_check"', () => {
        const evidence = collectEvidenceFromToolResults([{ toolName: "get_goal" }]);
        expect(evidence).toHaveLength(1);
        expect(evidence[0].kind).toBe("goal_check");
    });
    it('"update_goal" → null', () => {
        expect(collectEvidenceFromToolResults([{ toolName: "update_goal" }])).toHaveLength(0);
    });
    it('"clear_goal" → null', () => {
        expect(collectEvidenceFromToolResults([{ toolName: "clear_goal" }])).toHaveLength(0);
    });
    it('"read" → "file_inspection"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "read" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("file_inspection");
    });
    it('"grep" → "file_inspection"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "grep" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("file_inspection");
    });
    it('"find" → "file_inspection"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "find" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("file_inspection");
    });
    it('"ls" → "file_inspection"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "ls" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("file_inspection");
    });
    it('"edit" → "file_change"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "edit" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("file_change");
    });
    it('"write" → "file_change"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "write" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("file_change");
    });
    it('"test" → "test_run"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "test" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("test_run");
    });
    it('"verify" → "test_run"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "verify" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("test_run");
    });
    it('"build" → "test_run"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "build" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("test_run");
    });
    it('"lint" → "test_run"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "lint" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("test_run");
    });
    it('"typecheck" → "test_run"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "typecheck" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("test_run");
    });
    it('"typecheck_all" (substr) → "test_run"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "typecheck_all" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("test_run");
    });
    it('"test_all_tests" (substr) → "test_run"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "test_all_tests" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("test_run");
    });
    it('"verify_pr" (substr) → "test_run"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "verify_pr" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("test_run");
    });
    it('"lint_fix" (substr) → "test_run"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "lint_fix" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("test_run");
    });
    it('"build_release" (substr) → "test_run"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "build_release" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("test_run");
    });
    it('"bash" → "command_output"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "bash" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("command_output");
    });
    it('"shell" → "command_output"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "shell" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("command_output");
    });
    it('"web_search" → "verification_tool"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "web_search" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("verification_tool");
    });
    it('"code_search" → "verification_tool"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "code_search" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("verification_tool");
    });
    it('"ask_user_question" (unknown) → "verification_tool"', () => {
        const e = collectEvidenceFromToolResults([{ toolName: "ask_user_question" }]);
        expect(e).toHaveLength(1);
        expect(e[0].kind).toBe("verification_tool");
    });
});
describe("collectEvidenceFromToolResults", () => {
    it("two \"read\" calls → only 1 evidence item (dedup by kind)", () => {
        const evidence = collectEvidenceFromToolResults([
            { toolName: "read", isError: false },
            { toolName: "read", isError: false },
        ]);
        expect(evidence).toHaveLength(1);
        expect(evidence[0].kind).toBe("file_inspection");
    });
    it("three \"grep\" calls → only 1 evidence item", () => {
        const evidence = collectEvidenceFromToolResults([
            { toolName: "grep" },
            { toolName: "grep" },
            { toolName: "grep" },
        ]);
        expect(evidence).toHaveLength(1);
    });
    it("read + edit + bash → 3 items with correct kinds", () => {
        const evidence = collectEvidenceFromToolResults([
            { toolName: "read" },
            { toolName: "edit" },
            { toolName: "bash" },
        ]);
        expect(evidence).toHaveLength(3);
        const kinds = evidence.map((e) => e.kind);
        expect(kinds).toContain("file_inspection");
        expect(kinds).toContain("file_change");
        expect(kinds).toContain("command_output");
    });
    it("read(error) + edit(ok) → only edit evidence", () => {
        const evidence = collectEvidenceFromToolResults([
            { toolName: "read", isError: true },
            { toolName: "edit", isError: false },
        ]);
        expect(evidence).toHaveLength(1);
        expect(evidence[0].kind).toBe("file_change");
    });
    it("all goal mutators → empty array", () => {
        const evidence = collectEvidenceFromToolResults([
            { toolName: "update_goal" },
            { toolName: "clear_goal" },
        ]);
        expect(evidence).toHaveLength(0);
    });
    it("preserves toolName in evidence", () => {
        const evidence = collectEvidenceFromToolResults([
            { toolName: "grep" },
            { toolName: "edit" },
            { toolName: "bash" },
        ]);
        const byKind = new Map(evidence.map((e) => [e.kind, e.toolName]));
        expect(byKind.get("file_inspection")).toBe("grep");
        expect(byKind.get("file_change")).toBe("edit");
        expect(byKind.get("command_output")).toBe("bash");
    });
    it("timestamps are ISO strings", () => {
        const evidence = collectEvidenceFromToolResults([{ toolName: "read" }]);
        expect(evidence).toHaveLength(1);
        expect(evidence[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
    it("isError defaults to false (not missing) — produces evidence", () => {
        const evidence = collectEvidenceFromToolResults([{ toolName: "read" }]);
        expect(evidence).toHaveLength(1);
    });
});
describe("checkEvidence", () => {
    it("empty → passed=false, missing contains \"No verification evidence\"", () => {
        const result = checkEvidence([]);
        expect(result.passed).toBe(false);
        expect(result.missing.join(" ")).toContain("No verification evidence");
        expect(result.message).toContain("No tool evidence");
    });
    it("single kind (only file_change) → passed=false, missing contains \"too narrow\"", () => {
        const result = checkEvidence([makeEvidence("file_change")]);
        expect(result.passed).toBe(false);
        expect(result.missing.join(" ")).toContain("Evidence is too narrow");
        expect(result.missing.join(" ")).toContain("at least 2 distinct");
    });
    it("only file_inspection → passed=false, missing contains all three messages", () => {
        const result = checkEvidence([makeEvidence("file_inspection")]);
        expect(result.passed).toBe(false);
        expect(result.missing.join(" ")).toContain("Evidence is too narrow");
        expect(result.missing.join(" ")).toContain("only file inspection");
        expect(result.missing.join(" ")).toContain("No file changes or test results");
    });
    it("file_inspection + command_output → passed=false, missing contains \"No file changes or test results\"", () => {
        const result = checkEvidence([
            makeEvidence("file_inspection"),
            makeEvidence("command_output"),
        ]);
        expect(result.passed).toBe(false);
        expect(result.missing.join(" ")).toContain("No file changes or test results");
    });
    it("file_change + test_run → passed=true", () => {
        const result = checkEvidence([
            makeEvidence("file_change"),
            makeEvidence("test_run"),
        ]);
        expect(result.passed).toBe(true);
        expect(result.missing).toHaveLength(0);
    });
    it("command_output + verification_tool → passed=false (no change/test)", () => {
        const result = checkEvidence([
            makeEvidence("command_output"),
            makeEvidence("verification_tool"),
        ]);
        expect(result.passed).toBe(false);
        expect(result.missing.join(" ")).toContain("No file changes or test results");
    });
    it("3 kinds with file_change (no test) → passed=true (hasChange satisfies)", () => {
        const result = checkEvidence([
            makeEvidence("file_inspection"),
            makeEvidence("command_output"),
            makeEvidence("file_change"),
        ]);
        expect(result.passed).toBe(true);
        expect(result.missing).toHaveLength(0);
    });
    it("all 6 kinds → passed=true", () => {
        const kinds = [
            "goal_check",
            "file_inspection",
            "file_change",
            "test_run",
            "command_output",
            "verification_tool",
        ];
        const result = checkEvidence(kinds.map((k) => makeEvidence(k)));
        expect(result.passed).toBe(true);
        expect(result.missing).toHaveLength(0);
        expect(result.evidenceCount).toBe(6);
    });
    it("empty evidence message is exact", () => {
        const result = checkEvidence([]);
        expect(result.missing[0]).toBe("No verification evidence found in this turn. The model must use tools to inspect or modify the codebase before claiming completion.");
    });
    it("too narrow message is exact", () => {
        const result = checkEvidence([makeEvidence("file_change")]);
        expect(result.missing[0]).toBe("Evidence is too narrow. Provide at least 2 distinct evidence kinds (for example: file_change + test_run, or file_inspection + command_output).");
    });
    it("only file inspection message is exact", () => {
        const result = checkEvidence([makeEvidence("file_inspection")]);
        expect(result.missing.join(" ")).toContain("No execution, test, or command-output evidence — only file inspection. Cannot confirm completion without concrete verification.");
    });
    it("no file changes or test results message is exact", () => {
        const result = checkEvidence([makeEvidence("file_inspection")]);
        expect(result.missing.join(" ")).toContain("No file changes or test results. The goal likely requires code changes or verification tests.");
    });
    it("evidenceSummary groups by kind", () => {
        const result = checkEvidence([
            makeEvidence("file_change", "edit"),
            makeEvidence("test_run", "test"),
        ]);
        expect(result.evidenceSummary).toHaveLength(2);
        expect(result.evidenceSummary.join(" ")).toContain("file_change");
        expect(result.evidenceSummary.join(" ")).toContain("test_run");
    });
    it("evidenceCount matches evidence length", () => {
        const result = checkEvidence([
            makeEvidence("file_change"),
            makeEvidence("test_run"),
            makeEvidence("file_inspection"),
        ]);
        expect(result.evidenceCount).toBe(3);
    });
});
describe("applyVerifierPolicy", () => {
    const sufficientEvidence: EvidenceItem[] = [
        makeEvidence("file_change"),
        makeEvidence("test_run"),
    ];
    const insufficientEvidence: EvidenceItem[] = [makeEvidence("file_inspection")];
    it('"off" → allow=true, passed=true, message mentions "disabled"', () => {
        const decision = applyVerifierPolicy("off", insufficientEvidence);
        expect(decision.allow).toBe(true);
        expect(decision.result.passed).toBe(true);
        expect(decision.result.message).toContain("disabled");
        expect(decision.result.message).toContain("off");
    });
    it('"off" → empty evidenceSummary and missing', () => {
        const decision = applyVerifierPolicy("off", []);
        expect(decision.result.evidenceSummary).toHaveLength(0);
        expect(decision.result.missing).toHaveLength(0);
    });
    it('"warn" + sufficient evidence → allow=true, message="Verification passed."', () => {
        const decision = applyVerifierPolicy("warn", sufficientEvidence);
        expect(decision.allow).toBe(true);
        expect(decision.result.passed).toBe(true);
        expect(decision.result.message).toBe("Verification passed.");
    });
    it('"warn" + insufficient evidence → allow=true, message starts with "[VERIFIER WARN]"', () => {
        const decision = applyVerifierPolicy("warn", insufficientEvidence);
        expect(decision.allow).toBe(true);
        expect(decision.result.passed).toBe(false);
        expect(decision.result.message).toMatch(/^\[VERIFIER WARN\]/);
    });
    it('"enforce" + sufficient evidence → allow=true, message="Sufficient verification evidence collected."', () => {
        const decision = applyVerifierPolicy("enforce", sufficientEvidence);
        expect(decision.allow).toBe(true);
        expect(decision.result.passed).toBe(true);
        expect(decision.result.message).toBe("Sufficient verification evidence collected.");
    });
    it('"enforce" + insufficient evidence → allow=false, message starts with "[VERIFIER BLOCKED]"', () => {
        const decision = applyVerifierPolicy("enforce", insufficientEvidence);
        expect(decision.allow).toBe(false);
        expect(decision.result.passed).toBe(false);
        expect(decision.result.message).toMatch(/^\[VERIFIER BLOCKED\]/);
    });
    it("result object contains evidenceCount", () => {
        const decision = applyVerifierPolicy("warn", sufficientEvidence);
        expect(decision.result.evidenceCount).toBe(sufficientEvidence.length);
    });
    it("result object contains evidenceSummary", () => {
        const decision = applyVerifierPolicy("warn", sufficientEvidence);
        expect(decision.result.evidenceSummary).toBeDefined();
        expect(Array.isArray(decision.result.evidenceSummary)).toBe(true);
    });
    it("result object contains missing", () => {
        const decision = applyVerifierPolicy("warn", insufficientEvidence);
        expect(decision.result.missing).toBeDefined();
        expect(Array.isArray(decision.result.missing)).toBe(true);
        expect(decision.result.missing.length).toBeGreaterThan(0);
    });
    it('"off" with sufficient evidence still allows (verifier skipped)', () => {
        const decision = applyVerifierPolicy("off", sufficientEvidence);
        expect(decision.allow).toBe(true);
    });
});

describe("collectEvidenceFromToolResults — additional edge cases", () => {
    it("tool 'attest' → test_run (contains 'test')", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "attest" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("test_run");
    });
    it("tool 'build_script' → test_run (contains 'build')", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "build_script" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("test_run");
    });
    it("tool 'lint_check' → test_run (contains 'lint')", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "lint_check" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("test_run");
    });
    it("tool 'typecheck_task' → test_run (contains 'typecheck')", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "typecheck_task" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("test_run");
    });
    it("tool 'testify' → test_run (contains 'test')", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "testify" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("test_run");
    });
    it("tool 'verify_sig' → test_run (contains 'verify')", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "verify_sig" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("test_run");
    });
    it("tool 'verify_output' → test_run", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "verify_output" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("test_run");
    });
    it("tool 'build_runner' → test_run", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "build_runner" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("test_run");
    });
    it("tool 'test_file' → test_run", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "test_file" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("test_run");
    });
    it("tool 'TEST' (uppercase) → test_run", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "TEST" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("test_run");
    });
    it("tool 'Test' (mixed case) → test_run", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "Test" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("test_run");
    });
    it("tool 'Build' (mixed case) → test_run", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "Build" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("test_run");
    });
    it("tool 'LINT' (uppercase) → test_run", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "LINT" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("test_run");
    });
    it("tool 'polyfill' → verification_tool (no VERIFY_HINTS match)", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "polyfill" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("verification_tool");
    });
    it("tool 'building' → test_run (contains 'build')", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "building" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("test_run");
    });
    it("tool 'collate' → verification_tool", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "collate" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("verification_tool");
    });
    it("tool 'ask_user_question' → verification_tool", () => {
        const e = collectEvidenceFromToolResults([{ toolName: "ask_user_question" }]);
        expect(e).toHaveLength(1); expect(e[0].kind).toBe("verification_tool");
    });
});

describe("checkEvidence — additional scenarios", () => {
    it("file_change + verification_tool passes", () => {
        const result = checkEvidence([makeEvidence("file_change"), makeEvidence("verification_tool")]);
        expect(result.passed).toBe(true);
    });
    it("test_run without file_change fails", () => {
        const result = checkEvidence([makeEvidence("test_run")]);
        expect(result.passed).toBe(false);
    });
    it("read + test_run passes", () => {
        const result = checkEvidence([makeEvidence("file_inspection"), makeEvidence("test_run")]);
        expect(result.passed).toBe(true);
    });
    it("command_output + file_change passes", () => {
        const result = checkEvidence([makeEvidence("command_output"), makeEvidence("file_change")]);
        expect(result.passed).toBe(true);
    });
    it("goal_check alone fails", () => {
        const result = checkEvidence([makeEvidence("goal_check")]);
        expect(result.passed).toBe(false);
    });
    it("verification_tool alone fails", () => {
        const result = checkEvidence([makeEvidence("verification_tool")]);
        expect(result.passed).toBe(false);
    });
    it("file_inspection + command_output (no change/test) fails", () => {
        const result = checkEvidence([makeEvidence("file_inspection"), makeEvidence("command_output")]);
        expect(result.passed).toBe(false);
    });
});
