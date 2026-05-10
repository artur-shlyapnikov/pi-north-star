import { describe, it, expect, beforeEach } from "bun:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { GOAL_EVENT_CUSTOM_TYPE, SNAPSHOT_CUSTOM_TYPE, type AccountingMode, type GoalSnapshot, type VerifierPolicy, } from "../../src/goal/goal-types";
import { GoalManager } from "../../src/goal/goal-manager";
import { accountTokenDelta } from "../../src/runtime/accounting";
import { loadGoalFromEntries, persistGoal, emitGoalEvent } from "../../src/persistence/goal-persistence";
import { applyStatusLine, formatDuration, formatTokensShort } from "../../src/presentation/status-line";
function makeEntry(customType: string, data: unknown): SessionEntry {
    return { type: "custom", customType, data: data as Record<string, unknown> };
}
function makeGoal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
    const now = new Date().toISOString();
    return {
        schemaVersion: 1,
        id: "test-goal-1",
        revision: 1,
        objective: "test objective",
        status: "active",
        tokenBudget: 100,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: now,
        updatedAt: now,
        continuationSequence: 0,
        ...overrides,
    };
}
function mockPI() {
    const entries: SessionEntry[] = [];
    const messages: Array<{
        customType: string;
        content: string;
    }> = [];
    return {
        entries,
        messages,
        appendEntry(customType: string, data: unknown) {
            entries.push(makeEntry(customType, data));
        },
        sendMessage(msg: {
            customType: string;
            content: string;
            display: boolean;
            details: Record<string, unknown>;
        }, _opts: {
            triggerTurn: boolean;
        }) {
            messages.push({ customType: msg.customType, content: msg.content });
        },
    };
}
function mockCtx(hasUI = false): ExtensionContext {
    let statusText: string | undefined = undefined;
    let widgetLines: string[] | undefined = undefined;
    let widgetPlacement = "";
    return {
        hasUI,
        sessionManager: {
            getBranch: () => [],
        },
        ui: {
            setStatus(_key: string, text: string | undefined) {
                statusText = text;
            },
            setWidget(_key: string, lines: string[] | undefined, opts: {
                placement: string;
            }) {
                widgetLines = lines ?? undefined;
                widgetPlacement = opts?.placement ?? "";
            },
            _status() { return statusText; },
            _widget() { return widgetLines; },
            _placement() { return widgetPlacement; },
        },
    } as unknown as ExtensionContext;
}
describe("loadGoalFromEntries", () => {
    it("returns last valid snapshot from entries", () => {
        const entries: SessionEntry[] = [
            makeEntry(SNAPSHOT_CUSTOM_TYPE, { reason: "created", goal: makeGoal({ id: "first", revision: 1 }) }),
            makeEntry(SNAPSHOT_CUSTOM_TYPE, { reason: "updated", goal: makeGoal({ id: "second", revision: 2 }) }),
        ];
        const result = loadGoalFromEntries(entries);
        expect(result!.id).toBe("second");
        expect(result!.revision).toBe(2);
    });
    it("ignores non-snapshot entries", () => {
        const entries: SessionEntry[] = [
            makeEntry("other.type", { data: "ignore" }),
            makeEntry(SNAPSHOT_CUSTOM_TYPE, { reason: "created", goal: makeGoal({ id: "keep", revision: 1 }) }),
        ];
        expect(loadGoalFromEntries(entries)!.id).toBe("keep");
    });
    it("ignores entries without data or goal", () => {
        const entries: SessionEntry[] = [
            makeEntry(SNAPSHOT_CUSTOM_TYPE, { reason: "created" }),
            makeEntry(SNAPSHOT_CUSTOM_TYPE, { goal: null }),
            makeEntry(SNAPSHOT_CUSTOM_TYPE, { reason: "updated", goal: makeGoal({ id: "keep", revision: 2 }) }),
        ];
        expect(loadGoalFromEntries(entries)!.id).toBe("keep");
    });
    it("handles explicit clear (wrapper.goal === null sets last=null)", () => {
        const entries: SessionEntry[] = [
            makeEntry(SNAPSHOT_CUSTOM_TYPE, { reason: "created", goal: makeGoal({ id: "first", revision: 1 }) }),
            makeEntry(SNAPSHOT_CUSTOM_TYPE, { reason: "cleared", goal: null }),
        ];
        expect(loadGoalFromEntries(entries)).toBeNull();
    });
    it("handles migration: old snapshot without revision gets revision=1", () => {
        const oldGoal = { schemaVersion: 1, id: "old", objective: "old goal", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), continuationSequence: 0 };
        const entries: SessionEntry[] = [
            makeEntry(SNAPSHOT_CUSTOM_TYPE, { reason: "created", goal: oldGoal }),
        ];
        const result = loadGoalFromEntries(entries);
        expect(result!.revision).toBe(1);
    });
    it("returns null for empty entries", () => {
        expect(loadGoalFromEntries([])).toBeNull();
    });
});
describe("persistGoal", () => {
    it("appends entry with correct customType and data", () => {
        const pi = mockPI();
        const goal = makeGoal();
        persistGoal(pi as unknown as ExtensionAPI, goal, "created");
        expect(pi.entries).toHaveLength(1);
        expect(pi.entries[0].customType).toBe(SNAPSHOT_CUSTOM_TYPE);
        expect((pi.entries[0].data as {
            reason: string;
        }).reason).toBe("created");
        expect(((pi.entries[0].data as {
            goal: GoalSnapshot;
        }).goal).id).toBe(goal.id);
    });
    it("allows null goal (clear marker)", () => {
        const pi = mockPI();
        persistGoal(pi as unknown as ExtensionAPI, null, "cleared");
        expect(pi.entries).toHaveLength(1);
        expect((pi.entries[0].data as {
            goal: null;
        }).goal).toBeNull();
    });
    it("throws if goal snapshot lacks numeric revision", () => {
        const pi = mockPI();
        const bad = makeGoal();
        delete (bad as unknown as Record<string, unknown>).revision;
        expect(() => persistGoal(pi as unknown as ExtensionAPI, bad, "updated")).toThrow("must have a revision");
    });
    it("emits goal event (reason !== usage)", () => {
        const pi = mockPI();
        persistGoal(pi as unknown as ExtensionAPI, makeGoal(), "created");
        expect(pi.messages).toHaveLength(1);
        expect(pi.messages[0].customType).toBe(GOAL_EVENT_CUSTOM_TYPE);
    });
});
describe("emitGoalEvent", () => {
    it("does NOT emit for reason=usage", () => {
        const pi = mockPI();
        emitGoalEvent(pi as unknown as ExtensionAPI, makeGoal(), "usage");
        expect(pi.messages).toHaveLength(0);
    });
    it("emits for created", () => {
        const pi = mockPI();
        emitGoalEvent(pi as unknown as ExtensionAPI, makeGoal(), "created");
        expect(pi.messages).toHaveLength(1);
    });
    it("emits for paused", () => {
        const pi = mockPI();
        emitGoalEvent(pi as unknown as ExtensionAPI, makeGoal(), "paused");
        expect(pi.messages).toHaveLength(1);
    });
    it("emits for completed", () => {
        const pi = mockPI();
        emitGoalEvent(pi as unknown as ExtensionAPI, makeGoal(), "completed");
        expect(pi.messages).toHaveLength(1);
    });
});
describe("formatTokensShort", () => {
    it("0 → '0'", () => {
        expect(formatTokensShort(0)).toBe("0");
    });
    it("999 → '999'", () => {
        expect(formatTokensShort(999)).toBe("999");
    });
    it("1200 → '1.2k'", () => {
        expect(formatTokensShort(1200)).toBe("1.2k");
    });
    it("12000 → '12k'", () => {
        expect(formatTokensShort(12000)).toBe("12k");
    });
    it("1_200_000 → '1.2M'", () => {
        expect(formatTokensShort(1200000)).toBe("1.2M");
    });
});
describe("formatDuration", () => {
    it("30s → '30s'", () => {
        expect(formatDuration(30)).toBe("30s");
    });
    it("90s → '1m 30s'", () => {
        expect(formatDuration(90)).toBe("1m 30s");
    });
    it("3661s → '1h 1m 1s'", () => {
        expect(formatDuration(3661)).toBe("1h 1m 1s");
    });
});
describe("accountTokenDelta", () => {
    it("input=100 cachedInput=30 output=50 → 120", () => {
        expect(accountTokenDelta({ input: 100, cachedInput: 30, output: 50 })).toBe(120);
    });
    it("cachedInput > input → clamp to 0", () => {
        expect(accountTokenDelta({ input: 30, cachedInput: 100, output: 10 })).toBe(10);
    });
    it("all zeros → 0", () => {
        expect(accountTokenDelta({ input: 0, cachedInput: 0, output: 0 })).toBe(0);
    });
});
describe("applyStatusLine", () => {
    it("active goal with budget → sets status text", () => {
        const ctx = mockCtx(false);
        const gm = new GoalManager();
        gm.create("test", 100);
        applyStatusLine(ctx as unknown as ExtensionContext, gm);
        expect((ctx.ui as Record<string, () => unknown>)._status()).toMatch(/^goal: planning \d+\/100$/);
    });
    it("active goal without budget → 'goal: planning'", () => {
        const ctx = mockCtx(false);
        const gm = new GoalManager();
        gm.create("test");
        applyStatusLine(ctx as unknown as ExtensionContext, gm);
        expect((ctx.ui as Record<string, () => unknown>)._status()).toBe("goal: planning");
    });
    it("non-active → clears status (undefined)", () => {
        const ctx = mockCtx(false);
        const gm = new GoalManager();
        gm.create("test");
        gm.goal!.status = "complete";
        applyStatusLine(ctx as unknown as ExtensionContext, gm);
        expect((ctx.ui as Record<string, () => unknown>)._status()).toBeUndefined();
    });
    it("hasUI=true → sets widget", () => {
        const ctx = mockCtx(true);
        const gm = new GoalManager();
        gm.create("test", 100);
        applyStatusLine(ctx as unknown as ExtensionContext, gm);
        expect((ctx.ui as Record<string, () => unknown>)._widget()).not.toBeUndefined();
    });
    it("hasUI=true + no goal → hides widget", () => {
        const ctx = mockCtx(true);
        const gm = new GoalManager();
        applyStatusLine(ctx as unknown as ExtensionContext, gm);
        expect((ctx.ui as Record<string, () => unknown>)._widget()).toBeUndefined();
    });
    it("hasUI=true + non-active goal → hides widget", () => {
        const ctx = mockCtx(true);
        const gm = new GoalManager();
        gm.create("test", 100);
        gm.goal!.status = "paused";
        applyStatusLine(ctx as unknown as ExtensionContext, gm);
        expect((ctx.ui as Record<string, () => unknown>)._widget()).toBeUndefined();
    });
    it("hasUI=false → does NOT set widget", () => {
        const ctx = mockCtx(false);
        const gm = new GoalManager();
        gm.create("test", 100);
        applyStatusLine(ctx as unknown as ExtensionContext, gm);
        expect((ctx.ui as Record<string, () => unknown>)._widget()).toBeUndefined();
    });
});
describe("GoalManager.applyConfig", () => {
    it("sets planFileEnabled from config", () => {
        const gm = new GoalManager();
        expect(gm.planFileEnabled).toBe(true);
        gm.applyConfig({ planFileEnabled: false, verifierPolicy: "off" });
        expect(gm.planFileEnabled).toBe(false);
    });
    it("sets verifierPolicy from config", () => {
        const gm = new GoalManager();
        expect(gm.verifierPolicy).toBe("off");
        gm.applyConfig({ planFileEnabled: true, verifierPolicy: "enforce" });
        expect(gm.verifierPolicy).toBe("enforce");
    });
});
describe("GoalManager.updateLiveFromTurn", () => {
    function turn(toolResults: {
        toolName: string;
        isError?: boolean;
    }[]): TurnEndEvent {
        return { toolResults } as TurnEndEvent;
    }
    function makeActiveGM(): GoalManager {
        const gm = new GoalManager();
        gm.create("test");
        return gm;
    }
    it("error tool results + no success tools → 'blocked'", () => {
        const gm = makeActiveGM();
        gm.updateLiveFromTurn(turn([{ toolName: "bash", isError: true }]));
        expect(gm.livePhase).toBe("blocked");
    });
    it("success with verify hint tool → 'verifying'", () => {
        const gm = makeActiveGM();
        gm.updateLiveFromTurn(turn([{ toolName: "test", isError: false }]));
        expect(gm.livePhase).toBe("verifying");
    });
    it("success with edit/write → 'executing'", () => {
        const gm = makeActiveGM();
        gm.updateLiveFromTurn(turn([{ toolName: "edit", isError: false }]));
        expect(gm.livePhase).toBe("executing");
    });
    it("success with only read-only tools → 'planning'", () => {
        const gm = makeActiveGM();
        gm.updateLiveFromTurn(turn([{ toolName: "read", isError: false }, { toolName: "grep", isError: false }]));
        expect(gm.livePhase).toBe("planning");
    });
    it("success with mixed non-read-only → 'executing'", () => {
        const gm = makeActiveGM();
        gm.updateLiveFromTurn(turn([{ toolName: "read", isError: false }, { toolName: "edit", isError: false }]));
        expect(gm.livePhase).toBe("executing");
    });
    it("no tools at all → 'planning'", () => {
        const gm = makeActiveGM();
        gm.updateLiveFromTurn(turn([]));
        expect(gm.livePhase).toBe("planning");
    });
    it("goal not active → no change (returns early)", () => {
        const gm = new GoalManager();
        gm.create("test");
        gm.goal!.status = "complete";
        gm.livePhase = "verifying";
        gm.updateLiveFromTurn(turn([{ toolName: "edit", isError: false }]));
        expect(gm.livePhase).toBe("verifying");
    });
});
describe("GoalManager.updateBudget", () => {
    it("valid budget, used < budget → 'updated', status stays active", () => {
        const gm = new GoalManager();
        gm.create("test");
        gm.goal!.tokensUsed = 10;
        const result = gm.updateBudget(100, gm.goal!.id);
        expect(result).toBe("updated");
        expect(gm.goal!.status).toBe("active");
    });
    it("valid budget, used >= budget → 'budget_limited', status changes", () => {
        const gm = new GoalManager();
        gm.create("test", 50);
        gm.goal!.tokensUsed = 60;
        const result = gm.updateBudget(50, gm.goal!.id);
        expect(result).toBe("budget_limited");
        expect(gm.goal!.status).toBe("budget_limited");
    });
    it("budget=undefined on budget_limited goal → 'updated', status back to active", () => {
        const gm = new GoalManager();
        gm.create("test", 50);
        gm.goal!.tokensUsed = 60;
        gm.updateBudget(50, gm.goal!.id);
        expect(gm.goal!.status).toBe("budget_limited");
        const result = gm.updateBudget(undefined, gm.goal!.id);
        expect(result).toBe("updated");
        expect(gm.goal!.status).toBe("active");
    });
    it("no goal → 'no_goal'", () => {
        const gm = new GoalManager();
        expect(gm.updateBudget(100)).toBe("no_goal");
    });
    it("stale expectedGoalId → 'stale'", () => {
        const gm = new GoalManager();
        gm.create("test");
        expect(gm.updateBudget(100, "wrong-id")).toBe("stale");
    });
});
describe("GoalManager.accumulateUsage", () => {
    it("mode=active_only on paused goal → returns false, no change", () => {
        const gm = new GoalManager();
        gm.create("test");
        gm.pause("user");
        const result = gm.accumulateUsage(10, 5, gm.goal!.id, "active_only");
        expect(result).toBe(false);
        expect(gm.goal!.tokensUsed).toBe(0);
    });
    it("mode=active_or_complete on paused → returns false", () => {
        const gm = new GoalManager();
        gm.create("test");
        gm.pause("user");
        expect(gm.accumulateUsage(10, 5, gm.goal!.id, "active_or_complete")).toBe(false);
    });
    it("mode=active_or_complete on complete → allows exactly once, second call returns false", () => {
        const gm = new GoalManager();
        gm.create("test");
        gm.complete(gm.goal!.id);
        expect(gm.accumulateUsage(5, 0, gm.goal!.id, "active_or_complete")).toBe(false);
        expect(gm.accumulateUsage(5, 0, gm.goal!.id, "active_or_complete")).toBe(false);
    });
    it("tokens+time added correctly", () => {
        const gm = new GoalManager();
        gm.create("test");
        gm.accumulateUsage(100, 30, gm.goal!.id, "active_only");
        expect(gm.goal!.tokensUsed).toBe(100);
        expect(gm.goal!.timeUsedSeconds).toBe(30);
    });
    it("budget crossing triggers markBudgetLimited and returns true", () => {
        const gm = new GoalManager();
        gm.create("test", 100);
        expect(gm.goal!.tokensUsed).toBe(0);
        const result = gm.accumulateUsage(120, 0, gm.goal!.id, "active_only");
        expect(result).toBe(true);
        expect(gm.goal!.status).toBe("budget_limited");
    });
    it("stale expectedGoalId → returns false", () => {
        const gm = new GoalManager();
        gm.create("test");
        expect(gm.accumulateUsage(100, 0, "wrong-id", "active_only")).toBe(false);
    });
});
describe("GoalManager.computeAndAdvanceBaseline", () => {
    it("first call (baseline null) → delta = accountTokenDelta(current)", () => {
        const gm = new GoalManager();
        const delta = gm.computeAndAdvanceBaseline({ input: 100, cachedInput: 30, output: 50 });
        expect(delta).toBe(120);
    });
    it("second call → delta based on differences from baseline", () => {
        const gm = new GoalManager();
        gm.computeAndAdvanceBaseline({ input: 100, cachedInput: 30, output: 50 });
        const delta = gm.computeAndAdvanceBaseline({ input: 200, cachedInput: 50, output: 80 });
        expect(delta).toBe(110);
    });
    it("baseline advances after each call", () => {
        const gm = new GoalManager();
        const snap1 = { input: 100, cachedInput: 0, output: 50 };
        const snap2 = { input: 200, cachedInput: 0, output: 60 };
        const snap3 = { input: 300, cachedInput: 0, output: 70 };
        gm.computeAndAdvanceBaseline(snap1);
        expect(gm._turnAccountingBaseline).toEqual(snap1);
        gm.computeAndAdvanceBaseline(snap2);
        expect(gm._turnAccountingBaseline).toEqual(snap2);
        gm.computeAndAdvanceBaseline(snap3);
        expect(gm._turnAccountingBaseline).toEqual(snap3);
    });
});
describe("GoalManager.rebuildFromEntries", () => {
    it("restores goal from entries", () => {
        const entries: SessionEntry[] = [
            makeEntry(SNAPSHOT_CUSTOM_TYPE, { reason: "created", goal: makeGoal({ id: "restored", revision: 3 }) }),
        ];
        const gm = new GoalManager();
        gm.rebuildFromEntries(entries);
        expect(gm.goal!.id).toBe("restored");
        expect(gm.goal!.revision).toBe(3);
    });
    it("clears turnEvidence", () => {
        const gm = new GoalManager();
        gm.create("test");
        gm.recordTurnEvidence([{ toolName: "edit", isError: false }]);
        expect(gm.getTurnEvidence()).toHaveLength(1);
        const entries: SessionEntry[] = [
            makeEntry(SNAPSHOT_CUSTOM_TYPE, { reason: "updated", goal: makeGoal({ revision: 2 }) }),
        ];
        gm.rebuildFromEntries(entries);
        expect(gm.getTurnEvidence()).toHaveLength(0);
    });
    it("resets completionAccountingDone", () => {
        const gm = new GoalManager();
        gm.create("test");
        gm.complete(gm.goal!.id);
        gm.accumulateUsage(0, 0, gm.goal!.id, "active_or_complete");
        const entries: SessionEntry[] = [
            makeEntry(SNAPSHOT_CUSTOM_TYPE, { reason: "updated", goal: makeGoal({ revision: 2 }) }),
        ];
        gm.rebuildFromEntries(entries);
        gm.create("new goal");
        gm.complete(gm.goal!.id);
        expect(gm.accumulateUsage(0, 0, gm.goal!.id, "active_or_complete")).toBe(false);
        expect(gm.accumulateUsage(0, 0, gm.goal!.id, "active_or_complete")).toBe(false);
    });
});
describe("GoalManager.create", () => {
    it("creates new goal even if one exists", () => {
        const gm = new GoalManager();
        gm.create("old goal");
        const oldId = gm.goal!.id;
        gm.create("new goal");
        expect(gm.goal!.id).not.toBe(oldId);
        expect(gm.goal!.objective).toBe("new goal");
        expect(gm.goal!.revision).toBe(1);
    });
    it("create clears evidence", () => {
        const gm = new GoalManager();
        gm.create("test");
        gm.recordTurnEvidence([{ toolName: "edit", isError: false }]);
        expect(gm.getTurnEvidence()).toHaveLength(1);
        gm.create("new goal");
        expect(gm.getTurnEvidence()).toHaveLength(0);
    });
});
describe("GoalManager.clear", () => {
    it("without expectedGoalId → succeeds", () => {
        const gm = new GoalManager();
        gm.create("test");
        expect(gm.clear()).toBe(true);
        expect(gm.goal).toBeNull();
    });
  it("with wrong expectedGoalId → returns false", () => {
    const gm = new GoalManager();
    gm.create("test");
    expect(gm.clear("wrong-id")).toBe(false);
    expect(gm.goal).not.toBeNull();
  });
});

describe("GoalManager.pause", () => {
  it("preserves evidence on pause", () => {
    const gm = new GoalManager();
    gm.create("test");
    gm.recordTurnEvidence([{ toolName: "edit" }, { toolName: "bash" }]);
    gm.pause("user");
    expect(gm.getTurnEvidence()).toHaveLength(2);
  });
});

describe("GoalManager.resume", () => {
  it("sets livePhase=executing and clears pauseReason", () => {
    const gm = new GoalManager();
    gm.create("test");
    gm.pause("user");
    gm.resume();
    expect(gm.goal!.status).toBe("active");
    expect(gm.livePhase).toBe("executing");
    expect(gm.goal!.pauseReason).toBeUndefined();
  });

  it("resume with budget changes budget", () => {
    const gm = new GoalManager();
    gm.create("test", 500);
    gm.pause("user");
    gm.resume(1000);
    expect(gm.goal!.tokenBudget).toBe(1000);
  });

  it("resume from non-paused returns false", () => {
    const gm = new GoalManager();
    gm.create("test");
    expect(gm.resume(500)).toBe(false);
  });

  it("preserves evidence on resume", () => {
    const gm = new GoalManager();
    gm.create("test");
    gm.recordTurnEvidence([{ toolName: "edit" }]);
    gm.pause("user");
    gm.resume();
    expect(gm.getTurnEvidence()).toHaveLength(1);
  });
});

describe("GoalManager.complete semantics", () => {
  it("sets completedAt and clears evidence and sets verifying phase", () => {
    const gm = new GoalManager();
    gm.create("test");
    gm.recordTurnEvidence([{ toolName: "edit" }]);
    const result = gm.complete();
    expect(result).toBe(true);
    expect(gm.goal!.completedAt).toBeDefined();
    expect(gm.goal!.status).toBe("complete");
    expect(gm.livePhase).toBe("verifying");
    expect(gm.getTurnEvidence()).toHaveLength(0);
  });

  it("cannot be called twice", () => {
    const gm = new GoalManager();
    gm.create("test");
    expect(gm.complete()).toBe(true);
    expect(gm.complete()).toBe(false);
  });

  it("stale expectedGoalId fails", () => {
    const gm = new GoalManager();
    gm.create("test");
    expect(gm.complete("wrong-id")).toBe(false);
  });

  it("complete preserves evidence when not active", () => {
    const gm = new GoalManager();
    gm.create("test");
    gm.recordTurnEvidence([{ toolName: "edit" }, { toolName: "bash" }]);
    gm.pause("user");
    expect(gm.getTurnEvidence()).toHaveLength(2);
    gm.complete();
    expect(gm.getTurnEvidence()).toHaveLength(2);
  });

  it("accumulateUsage preserves evidence", () => {
    const gm = new GoalManager();
    gm.create("test", 1000);
    gm.recordTurnEvidence([{ toolName: "read" }]);
    gm.accumulateUsage(100, 0, gm.goal!.id, "active_only");
    expect(gm.getTurnEvidence()).toHaveLength(1);
  });

  it("updateBudget preserves evidence", () => {
    const gm = new GoalManager();
    gm.create("test", 100);
    gm.recordTurnEvidence([{ toolName: "bash" }]);
    gm.updateBudget(500);
    expect(gm.getTurnEvidence()).toHaveLength(1);
  });
});

describe("GoalManager.create replaces semantics", () => {
  it("new goal resets tokens, time, sequence, revision, completedAt, pauseReason", () => {
    const gm = new GoalManager();
    gm.create("original");
    gm.accumulateUsage(100, 10, gm.goal!.id, "active_only");
    gm.create("replacement");
    expect(gm.goal!.tokensUsed).toBe(0);
    expect(gm.goal!.timeUsedSeconds).toBe(0);
    expect(gm.goal!.continuationSequence).toBe(0);
    expect(gm.goal!.revision).toBe(1);
    expect(gm.goal!.completedAt).toBeUndefined();
    expect(gm.goal!.pauseReason).toBeUndefined();
    expect(gm.goal!.objective).toBe("replacement");
  });
});

describe("GoalManager.clear semantics", () => {
  it("clears evidence, livePhase, and accounting baseline", () => {
    const gm = new GoalManager();
    gm.create("test");
    gm.recordTurnEvidence([{ toolName: "read" }]);
    gm.livePhase = "executing";
    gm.computeAndAdvanceBaseline({ input: 100, cachedInput: 0, output: 50 });
    gm.clear();
    expect(gm.getTurnEvidence()).toHaveLength(0);
    expect(gm.livePhase).toBeNull();
    expect(gm._turnAccountingBaseline).toBeNull();
  });
});

describe("GoalManager.updateBudget — status transitions", () => {
  it("budget_limited + higher budget → active", () => {
    const gm = new GoalManager();
    gm.create("test", 500);
    gm.accumulateUsage(600, 0, gm.goal!.id, "active_only");
    expect(gm.goal!.status).toBe("budget_limited");
    const result = gm.updateBudget(2000);
    expect(result).toBe("updated");
    expect(gm.goal!.status).toBe("active");
  });

  it("budget_limited + budget removed → active", () => {
    const gm = new GoalManager();
    gm.create("test", 500);
    gm.accumulateUsage(600, 0, gm.goal!.id, "active_only");
    const result = gm.updateBudget(undefined);
    expect(result).toBe("updated");
    expect(gm.goal!.status).toBe("active");
    expect(gm.goal!.tokenBudget).toBeUndefined();
  });

  it("budget_limited + same/lower budget → stays budget_limited", () => {
    const gm = new GoalManager();
    gm.create("test", 500);
    gm.accumulateUsage(600, 0, gm.goal!.id, "active_only");
    const result = gm.updateBudget(600);
    expect(result).toBe("budget_limited");
    expect(gm.goal!.status).toBe("budget_limited");
  });

  it("paused goal: budget update keeps paused", () => {
    const gm = new GoalManager();
    gm.create("test", 100);
    gm.pause("user");
    const result = gm.updateBudget(500);
    expect(result).toBe("updated");
    expect(gm.goal!.status).toBe("paused");
  });

  it("complete goal with no prior budget: stays complete", () => {
    const gm = new GoalManager();
    gm.create("test");
    gm.goal!.status = "complete";
    const result = gm.updateBudget(500);
    expect(result).toBe("updated");
    expect(gm.goal!.status).toBe("complete");
  });
});

describe("GoalManager.computeAndAdvanceBaseline — edge cases", () => {
  it("negative input delta → 0", () => {
    const gm = new GoalManager();
    gm.goal = { schemaVersion: 1, id: "x", revision: 1, objective: "x", status: "active", tokenBudget: undefined, tokensUsed: 0, timeUsedSeconds: 0, createdAt: "", updatedAt: "", continuationSequence: 0 };
    gm.computeAndAdvanceBaseline({ input: 100, cachedInput: 0, output: 0 });
    const delta = gm.computeAndAdvanceBaseline({ input: 50, cachedInput: 0, output: 0 });
    expect(delta).toBe(0);
  });

  it("output decrease → 0 contribution", () => {
    const gm = new GoalManager();
    gm.goal = { schemaVersion: 1, id: "x", revision: 1, objective: "x", status: "active", tokenBudget: undefined, tokensUsed: 0, timeUsedSeconds: 0, createdAt: "", updatedAt: "", continuationSequence: 0 };
    gm.computeAndAdvanceBaseline({ input: 0, cachedInput: 0, output: 100 });
    const delta = gm.computeAndAdvanceBaseline({ input: 0, cachedInput: 0, output: 50 });
    expect(delta).toBe(0);
  });

  it("multiple snapshots produce incremental accounting", () => {
    const gm = new GoalManager();
    gm.goal = { schemaVersion: 1, id: "x", revision: 1, objective: "x", status: "active", tokenBudget: undefined, tokensUsed: 0, timeUsedSeconds: 0, createdAt: "", updatedAt: "", continuationSequence: 0 };
    const d1 = gm.computeAndAdvanceBaseline({ input: 100, cachedInput: 0, output: 10 });
    const d2 = gm.computeAndAdvanceBaseline({ input: 200, cachedInput: 0, output: 20 });
    const d3 = gm.computeAndAdvanceBaseline({ input: 300, cachedInput: 0, output: 30 });
    expect(d1).toBe(110);
    expect(d2).toBe(110);
    expect(d3).toBe(110);
  });
});

describe("GoalManager.create with budget exceeded", () => {
  it("budget=0 → immediately budget_limited", () => {
    const gm = new GoalManager();
    const snap = gm.create("zero budget", 0);
    expect(snap.status).toBe("budget_limited");
    expect(gm.goal!.status).toBe("budget_limited");
  });

  it("budget=100, tokensUsed=0 → active (under budget)", () => {
    const gm = new GoalManager();
    const snap = gm.create("under budget", 100);
    expect(snap.status).toBe("active");
  });
});

describe("GoalManager.verifyExpectedGoalPrecondition", () => {
  it("passes for matching id and revision", () => {
    const gm = new GoalManager();
    gm.create("test");
    const pre = gm.getExpectedGoalPrecondition();
    expect(gm.verifyExpectedGoalPrecondition(pre, gm.goal!)).toBe(true);
  });

  it("fails for null actual", () => {
    const gm = new GoalManager();
    expect(gm.verifyExpectedGoalPrecondition({ id: "x", revision: 1 }, null)).toBe(false);
  });

  it("fails for different id", () => {
    const gm = new GoalManager();
    gm.create("test");
    expect(gm.verifyExpectedGoalPrecondition({ id: "wrong", revision: 1 }, gm.goal!)).toBe(false);
  });

  it("fails for different revision", () => {
    const gm = new GoalManager();
    gm.create("test");
    gm.pause("user");
    expect(gm.verifyExpectedGoalPrecondition({ id: gm.goal!.id, revision: 1 }, gm.goal!)).toBe(false);
  });

  it("undefined always passes", () => {
    const gm = new GoalManager();
    gm.create("test");
    expect(gm.verifyExpectedGoalPrecondition(undefined, gm.goal!)).toBe(true);
    expect(gm.verifyExpectedGoalPrecondition(undefined, null)).toBe(true);
  });

  it("getExpectedGoalPrecondition returns undefined when no goal", () => {
    const gm = new GoalManager();
    expect(gm.getExpectedGoalPrecondition()).toBeUndefined();
  });
});
