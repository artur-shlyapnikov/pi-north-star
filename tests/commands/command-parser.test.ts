import { describe, it, expect } from "bun:test";
import { parseGoalCommand } from "../../src/commands/command-parser";
import type { ParsedGoalCommand } from "../../src/commands/command-parser";
function assertKind(cmd: ParsedGoalCommand, kind: ParsedGoalCommand["kind"]): void {
    expect(cmd.kind).toBe(kind);
}
describe("parseGoalCommand — typed parser", () => {
    describe("show", () => {
        it.each([
            { args: undefined, label: "undefined" },
            { args: "", label: "empty string" },
            { args: "   ", label: "whitespace only" },
        ])("$label → show", ({ args }) => {
            expect(parseGoalCommand(args)).toEqual({ kind: "show" });
        });
    });
    describe("create", () => {
        it("plain text → create", () => {
            expect(parseGoalCommand("my new objective")).toEqual({
                kind: "create",
                objective: "my new objective",
                budget: undefined,
            });
        });
        it("text with --budget → create with budget", () => {
            expect(parseGoalCommand("--budget 100 priced goal")).toEqual({
                kind: "create",
                objective: "priced goal",
                budget: 100,
            });
        });
        it("--budget 0 → create with budget (service validates)", () => {
            expect(parseGoalCommand("--budget 0 test")).toEqual({
                kind: "create",
                objective: "test",
                budget: 0,
            });
        });
        it("--budget abc test → syntax-error", () => {
            assertKind(parseGoalCommand("--budget abc test"), "syntax-error");
        });
        it("--budget 100 → syntax-error (missing objective)", () => {
            assertKind(parseGoalCommand("--budget 100"), "syntax-error");
        });
        it("--budget alone → syntax-error", () => {
            assertKind(parseGoalCommand("--budget"), "syntax-error");
        });
    });
    describe("pause", () => {
        it("pause → pause", () => {
            expect(parseGoalCommand("pause")).toEqual({ kind: "pause" });
        });
        it("pause extra → pause (extra ignored)", () => {
            expect(parseGoalCommand("pause extra")).toEqual({ kind: "pause" });
        });
        it("pause long text → pause (extra ignored)", () => {
            expect(parseGoalCommand("pause after this finishes and please stop working")).toEqual({ kind: "pause" });
        });
    });
    describe("resume", () => {
        it("resume → resume", () => {
            expect(parseGoalCommand("resume")).toEqual({ kind: "resume", budget: undefined });
        });
        it("resume --budget 500 → resume with budget", () => {
            expect(parseGoalCommand("resume --budget 500")).toEqual({
                kind: "resume",
                budget: 500,
            });
        });
        it("resume anything-else → syntax-error", () => {
            assertKind(parseGoalCommand("resume some random"), "syntax-error");
        });
        it("resume --budget (no number) → syntax-error", () => {
            assertKind(parseGoalCommand("resume --budget"), "syntax-error");
        });
        it("resume --budget abc → syntax-error", () => {
            assertKind(parseGoalCommand("resume --budget abc"), "syntax-error");
        });
    });
    describe("clear", () => {
        it("clear → clear", () => {
            expect(parseGoalCommand("clear")).toEqual({ kind: "clear" });
        });
        it("clear extra → clear (extra ignored)", () => {
            expect(parseGoalCommand("clear extra")).toEqual({ kind: "clear" });
        });
        it("clear long text → clear (extra ignored)", () => {
            expect(parseGoalCommand("clear please don't actually clear")).toEqual({ kind: "clear" });
        });
    });
    describe("replace", () => {
        it("replace <text> → replace", () => {
            expect(parseGoalCommand("replace new objective")).toEqual({
                kind: "replace",
                objective: "new objective",
                budget: undefined,
            });
        });
        it("replace --budget 200 newobj → replace with budget", () => {
            expect(parseGoalCommand("replace --budget 200 newobj")).toEqual({
                kind: "replace",
                objective: "newobj",
                budget: 200,
            });
        });
        it("replace --budget → syntax-error", () => {
            assertKind(parseGoalCommand("replace --budget"), "syntax-error");
        });
        it("replace --budget abc → syntax-error", () => {
            assertKind(parseGoalCommand("replace --budget abc abc"), "syntax-error");
        });
        it("replace '' (empty) → replace with empty (service validates)", () => {
            const r = parseGoalCommand("replace ");
            assertKind(r, "replace");
            if (r.kind === "replace") {
                expect(r.objective).toBe("");
            }
        });
    });
    describe("budget", () => {
        it("budget none → budget with undefined (remove)", () => {
            expect(parseGoalCommand("budget none")).toEqual({ kind: "budget", budget: undefined });
        });
        it("budget alone → budget with undefined", () => {
            expect(parseGoalCommand("budget")).toEqual({ kind: "budget", budget: undefined });
        });
        it("budget 500 → budget with number", () => {
            expect(parseGoalCommand("budget 500")).toEqual({ kind: "budget", budget: 500 });
        });
        it("budget 0 → budget with 0 (service validates)", () => {
            expect(parseGoalCommand("budget 0")).toEqual({ kind: "budget", budget: 0 });
        });
        it("budget abc → syntax-error", () => {
            assertKind(parseGoalCommand("budget abc"), "syntax-error");
        });
        it("budget 1.5 → syntax-error", () => {
            assertKind(parseGoalCommand("budget 1.5"), "syntax-error");
        });
        it("budget -1 → syntax-error", () => {
            assertKind(parseGoalCommand("budget -1"), "syntax-error");
        });
    });
    describe("verify", () => {
        it("verify alone → verify-show", () => {
            expect(parseGoalCommand("verify")).toEqual({ kind: "verify-show" });
        });
        it("verify enforce → verify-set", () => {
            const r = parseGoalCommand("verify enforce");
            assertKind(r, "verify-set");
            if (r.kind === "verify-set") {
                expect(r.policyRaw).toBe("enforce");
            }
        });
        it("verify strict → verify-set (service rejects)", () => {
            const r = parseGoalCommand("verify strict");
            assertKind(r, "verify-set");
            if (r.kind === "verify-set") {
                expect(r.policyRaw).toBe("strict");
            }
        });
        it("verify off → verify-set", () => {
            const r = parseGoalCommand("verify off");
            assertKind(r, "verify-set");
        });
    });
    describe("plan-file", () => {
        it("plan-file alone → plan-file-show", () => {
            expect(parseGoalCommand("plan-file")).toEqual({ kind: "plan-file-show" });
        });
        it("plan-file show → plan-file-show", () => {
            expect(parseGoalCommand("plan-file show")).toEqual({ kind: "plan-file-show" });
        });
        it("plan-file on → plan-file-set enabled=true", () => {
            expect(parseGoalCommand("plan-file on")).toEqual({ kind: "plan-file-set", enabled: true });
        });
        it("plan-file off → plan-file-set enabled=false", () => {
            expect(parseGoalCommand("plan-file off")).toEqual({ kind: "plan-file-set", enabled: false });
        });
        it("plan-file true → plan-file-set enabled=true", () => {
            expect(parseGoalCommand("plan-file true")).toEqual({ kind: "plan-file-set", enabled: true });
        });
        it("plan-file false → plan-file-set enabled=false", () => {
            expect(parseGoalCommand("plan-file false")).toEqual({ kind: "plan-file-set", enabled: false });
        });
        it("plan-file 1 → plan-file-set enabled=true", () => {
            expect(parseGoalCommand("plan-file 1")).toEqual({ kind: "plan-file-set", enabled: true });
        });
        it("plan-file 0 → plan-file-set enabled=false", () => {
            expect(parseGoalCommand("plan-file 0")).toEqual({ kind: "plan-file-set", enabled: false });
        });
        it("plan-file yes → plan-file-set enabled=true", () => {
            expect(parseGoalCommand("plan-file yes")).toEqual({ kind: "plan-file-set", enabled: true });
        });
        it("plan-file no → plan-file-set enabled=false", () => {
            expect(parseGoalCommand("plan-file no")).toEqual({ kind: "plan-file-set", enabled: false });
        });
        it("plan-file bad → syntax-error", () => {
            assertKind(parseGoalCommand("plan-file maybe"), "syntax-error");
        });
        it("planfile alias works → plan-file-show", () => {
            expect(parseGoalCommand("planfile")).toEqual({ kind: "plan-file-show" });
        });
        it("planfile on → plan-file-set enabled=true", () => {
            expect(parseGoalCommand("planfile on")).toEqual({ kind: "plan-file-set", enabled: true });
        });
        it("planfile off → plan-file-set enabled=false", () => {
            expect(parseGoalCommand("planfile off")).toEqual({ kind: "plan-file-set", enabled: false });
        });
    });
    describe("syntax-error usage strings", () => {
        it("unknown --budget pattern → correct usage for create", () => {
            const r = parseGoalCommand("--budget");
            if (r.kind === "syntax-error") {
                expect(r.usage).toContain("--budget");
            }
        });
        it("resume bad → correct resume usage", () => {
            const r = parseGoalCommand("resume blah");
            if (r.kind === "syntax-error") {
                expect(r.usage).toContain("resume");
            }
        });
        it("replace --budget → correct replace usage", () => {
            const r = parseGoalCommand("replace --budget");
            if (r.kind === "syntax-error") {
                expect(r.usage).toContain("replace");
            }
        });
        it("budget bad → correct budget usage", () => {
            const r = parseGoalCommand("budget abc");
            if (r.kind === "syntax-error") {
                expect(r.usage).toContain("budget");
            }
        });
    });

    describe("reserved-word ambiguity", () => {
        it("'pause deployment work' → pause", () => {
            expect(parseGoalCommand("pause deployment work").kind).toBe("pause");
        });
        it("'clear stale cache' → clear", () => {
            expect(parseGoalCommand("clear stale cache").kind).toBe("clear");
        });
        it("'budget migration task' → syntax-error", () => {
            expect(parseGoalCommand("budget migration task").kind).toBe("syntax-error");
        });
        it("'resume important task' → syntax-error", () => {
            expect(parseGoalCommand("resume important task").kind).toBe("syntax-error");
        });
        it("'replace old goal' → replace", () => {
            expect(parseGoalCommand("replace old goal").kind).toBe("replace");
        });
        it("'verify status' → verify-set with policyRaw='status'", () => {
            const r = parseGoalCommand("verify status");
            expect(r.kind).toBe("verify-set");
            if (r.kind === "verify-set") expect(r.policyRaw).toBe("status");
        });
        it("'test something' → create (no keyword match)", () => {
            const r = parseGoalCommand("test something");
            expect(r.kind).toBe("create");
            if (r.kind === "create") expect(r.objective).toBe("test something");
        });
    });

    describe("case sensitivity", () => {
        it("PAUSE → pause", () => { expect(parseGoalCommand("PAUSE").kind).toBe("pause"); });
        it("Pause → pause", () => { expect(parseGoalCommand("Pause").kind).toBe("pause"); });
        it("RESUME → resume", () => { expect(parseGoalCommand("RESUME").kind).toBe("resume"); });
        it("Resume → resume", () => { expect(parseGoalCommand("Resume").kind).toBe("resume"); });
        it("CLEAR → clear", () => { expect(parseGoalCommand("CLEAR").kind).toBe("clear"); });
        it("REPLACE → replace", () => {
            const r = parseGoalCommand("REPLACE new objective");
            expect(r.kind).toBe("replace");
            if (r.kind === "replace") expect(r.objective).toBe("new objective");
        });
        it("VERIFY ENFORCE → verify-set, policyRaw preserves case", () => {
            const r = parseGoalCommand("VERIFY ENFORCE");
            expect(r.kind).toBe("verify-set");
            if (r.kind === "verify-set") expect(r.policyRaw).toBe("ENFORCE");
        });
        it("budget NONE → syntax-error (case-sensitive)", () => {
            expect(parseGoalCommand("budget NONE").kind).toBe("syntax-error");
        });
        it("budget None → syntax-error (case-sensitive)", () => {
            expect(parseGoalCommand("budget None").kind).toBe("syntax-error");
        });
    });

    describe("verify argument matrix", () => {
        it("verify → verify-show", () => {
            expect(parseGoalCommand("verify").kind).toBe("verify-show");
        });
        it("verify enforce → verify-set policyRaw='enforce'", () => {
            const r = parseGoalCommand("verify enforce");
            expect(r.kind).toBe("verify-set");
            if (r.kind === "verify-set") expect(r.policyRaw).toBe("enforce");
        });
        it("verify ENFORCE → verify-set policyRaw='ENFORCE'", () => {
            const r = parseGoalCommand("verify ENFORCE");
            expect(r.kind).toBe("verify-set");
            if (r.kind === "verify-set") expect(r.policyRaw).toBe("ENFORCE");
        });
        it("verify off → verify-set policyRaw='off'", () => {
            expect(parseGoalCommand("verify off").kind).toBe("verify-set");
        });
        it("verify warn → verify-set policyRaw='warn'", () => {
            const r = parseGoalCommand("verify warn");
            expect(r.kind).toBe("verify-set");
            if (r.kind === "verify-set") expect(r.policyRaw).toBe("warn");
        });
        it("verify enforce now → verify-set policyRaw='enforce now'", () => {
            const r = parseGoalCommand("verify enforce now");
            expect(r.kind).toBe("verify-set");
            if (r.kind === "verify-set") expect(r.policyRaw).toBe("enforce now");
        });
        it("verify off extra → verify-set policyRaw='off extra'", () => {
            const r = parseGoalCommand("verify off extra");
            expect(r.kind).toBe("verify-set");
            if (r.kind === "verify-set") expect(r.policyRaw).toBe("off extra");
        });
        it("verify strict → verify-set policyRaw='strict'", () => {
            const r = parseGoalCommand("verify strict");
            expect(r.kind).toBe("verify-set");
            if (r.kind === "verify-set") expect(r.policyRaw).toBe("strict");
        });
    });

    describe("budget flag placement", () => {
        it("prefix --budget <N> <objective> → create with budget", () => {
            const r = parseGoalCommand("--budget 100 my objective");
            expect(r.kind).toBe("create");
            if (r.kind === "create") { expect(r.budget).toBe(100); expect(r.objective).toBe("my objective"); }
        });
        it("objective before --budget → treated as objective text", () => {
            const r = parseGoalCommand("my objective --budget 100");
            expect(r.kind).toBe("create");
            if (r.kind === "create") { expect(r.objective).toBe("my objective --budget 100"); expect(r.budget).toBeUndefined(); }
        });
        it("replace objective --budget 100 → --budget treated as objective text", () => {
            const r = parseGoalCommand("replace objective --budget 100");
            expect(r.kind).toBe("replace");
            if (r.kind === "replace") { expect(r.objective).toBe("objective --budget 100"); expect(r.budget).toBeUndefined(); }
        });
        it("replace --budget <N> <objective> → correct placement", () => {
            const r = parseGoalCommand("replace --budget 100 my objective");
            expect(r.kind).toBe("replace");
            if (r.kind === "replace") { expect(r.budget).toBe(100); expect(r.objective).toBe("my objective"); }
        });
        it("resume <text> --budget 100 → syntax-error", () => {
            expect(parseGoalCommand("resume some text --budget 100").kind).toBe("syntax-error");
        });
        it("resume --budget with leading zero → parsed", () => {
            const r = parseGoalCommand("resume --budget 01");
            expect(r.kind).toBe("resume");
            if (r.kind === "resume") expect(r.budget).toBe(1);
        });
    });

    describe("multiple budget flags", () => {
        it("--budget 100 --budget 200 objective → first wins", () => {
            const r = parseGoalCommand("--budget 100 --budget 200 objective");
            expect(r.kind).toBe("create");
            if (r.kind === "create") { expect(r.budget).toBe(100); expect(r.objective).toBe("--budget 200 objective"); }
        });
        it("replace --budget 100 --budget 200 objective → first wins", () => {
            const r = parseGoalCommand("replace --budget 100 --budget 200 objective");
            expect(r.kind).toBe("replace");
            if (r.kind === "replace") { expect(r.budget).toBe(100); expect(r.objective).toBe("--budget 200 objective"); }
        });
    });

    describe("budget parsing edge cases", () => {
        it("--budget 007 test → creates with budget 7", () => {
            const r = parseGoalCommand("--budget 007 test");
            expect(r.kind).toBe("create");
            if (r.kind === "create") expect(r.budget).toBe(7);
        });
        it("--budget -1 test → syntax-error (negative)", () => {
            expect(parseGoalCommand("--budget -1 test").kind).toBe("syntax-error");
        });
        it("--budget +100 test → syntax-error (plus sign)", () => {
            expect(parseGoalCommand("--budget +100 test").kind).toBe("syntax-error");
        });
        it("budget 0100 → budget=100 (leading zeros)", () => {
            const r = parseGoalCommand("budget 0100");
            expect(r.kind).toBe("budget");
            if (r.kind === "budget") expect(r.budget).toBe(100);
        });
        it("budget 1e3 → syntax-error (scientific notation)", () => {
            expect(parseGoalCommand("budget 1e3").kind).toBe("syntax-error");
        });
    });
});
