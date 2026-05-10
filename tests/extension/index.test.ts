import { describe, it, expect, beforeEach, vi } from "bun:test";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { makeGoalSnapshot, makeGoalSnapshotEntry } from "../fixtures/test-fixtures";
function createMockExtensionAPI(): ExtensionAPI {
    const entries: any[] = [];
    const messages: any[] = [];
    const tools: any[] = [];
    const commands: any[] = [];
    const activeTools: string[] = [];
    const listeners: Record<string, Function[]> = {};
    return {
        appendEntry: (type, data) => entries.push({ type, data }),
        sendMessage: (msg, opts) => messages.push({ msg, opts }),
        registerTool: (tool) => tools.push(tool),
        registerCommand: (name, def) => commands.push({ name, def }),
        getActiveTools: () => activeTools.map(n => ({ name: n })),
        getAllTools: () => [
            { name: "get_goal" },
            { name: "update_goal" },
            { name: "clear_goal" },
            { name: "other" },
        ],
        setActiveTools: (names) => { activeTools.length = 0; activeTools.push(...names); },
        on: (event, handler) => { (listeners[event] ||= []).push(handler); },
        _entries: entries,
        _messages: messages,
        _tools: tools,
        _commands: commands,
        _listeners: listeners,
        _emit: (event: string, ...args: any[]) => (listeners[event] || []).forEach(h => h(...args)),
    } as any;
}
function createMockContext(opts?: {
    branch?: any[];
    hasUI?: boolean;
}): ExtensionContext {
    return {
        sessionManager: { getBranch: () => opts?.branch || [] },
        hasUI: opts?.hasUI ?? true,
        ui: {
            setStatus: () => { },
            setWidget: () => { },
            notify: () => { },
        },
        hasPendingMessages: () => false,
        isIdle: () => true,
        signal: undefined,
    } as any;
}
function makeSnapshot(status: "active" | "paused" | "complete" | "budget_limited", overrides?: any) {
    return makeGoalSnapshot({
        id: "goal-1",
        objective: "Test goal",
        tokenBudget: 50000,
        status,
        ...overrides,
    });
}
function makeSnapshotEntry(goal: any) {
    return makeGoalSnapshotEntry(goal, "created");
}
let _extensionModule: {
    default: (api: ExtensionAPI) => void;
} | null = null;
async function getExtensionModule() {
    if (!_extensionModule) {
        const path = await import.meta.resolve("../../index.ts", import.meta.url);
        _extensionModule = await import(path);
    }
    return _extensionModule;
}
describe("goal extension index", () => {
    let api: ExtensionAPI;
    beforeEach(async () => {
        api = createMockExtensionAPI();
        _extensionModule = null;
        const mod = await getExtensionModule();
        mod.default(api);
    });
    describe("tool registration", () => {
        it("registers 3 goal tools", async () => {
            const names = api._tools.map((t: any) => t.name);
            expect(names).toContain("get_goal");
            expect(names).toContain("update_goal");
            expect(names).toContain("clear_goal");
            expect(names).toHaveLength(3);
        });
        it("each tool is registered via registerTool", async () => {
            expect(api._tools.length).toBe(3);
        });
    });
    describe("command registration", () => {
        it("registers a 'goal' command", async () => {
            expect(api._commands.length).toBe(1);
            expect(api._commands[0].name).toBe("goal");
        });
    });
    describe("event forwarding", () => {
        it.each([
            "agent_start",
            "turn_start",
            "turn_end",
            "agent_end",
            "session_shutdown",
            "session_start",
        ])('registers "%s" listener', async (event) => {
            expect(api._listeners[event]).toBeDefined();
            expect(typeof api._listeners[event][0]).toBe("function");
        });
    });
    describe("syncGoalActiveTools (no persisted goal)", () => {
        it("no goal → goal tools removed", async () => {
            api.setActiveTools(["get_goal", "update_goal", "clear_goal", "other"]);
            const ctx = createMockContext({ branch: [], hasUI: true });
            api._emit("session_start", {}, ctx);
            const names = api.getActiveTools().map(t => t.name).sort();
            expect(names).toEqual(["other"]);
        });
        it("no goal + already-truncated active list → restores non-goal tools from getAllTools()", async () => {
            api.setActiveTools([]);
            const ctx = createMockContext({ branch: [], hasUI: true });
            api._emit("session_start", {}, ctx);
            const names = api.getActiveTools().map(t => t.name).sort();
            expect(names).toEqual(["other"]);
        });
        it("single source path: uses getAllTools() only for reconstruction", async () => {
            api.setActiveTools(["get_goal", "update_goal", "clear_goal", "other"]);
            api.getAllTools = () => [{ name: "other" }];
            const ctx = createMockContext({ branch: [], hasUI: true });
            api._emit("session_start", {}, ctx);
            const names = api.getActiveTools().map(t => t.name).sort();
            expect(names).toEqual(["other"]);
        });
    });
    describe("syncGoalActiveTools (persisted active goal)", () => {
        it("active goal + truncated active list → restores non-goal tools and goal conditionals", async () => {
            api.setActiveTools([]);
            const goal = makeSnapshot("active");
            const branch = [makeSnapshotEntry(goal)];
            const ctx = createMockContext({ branch, hasUI: true });
            api._emit("session_start", {}, ctx);
            const names = api.getActiveTools().map(t => t.name).sort();
            expect(names).toEqual([
                "clear_goal",
                "get_goal",
                "other",
                "update_goal",
            ]);
        });
    });
    describe("session_start handler", () => {
        it("no persisted goal → applyStatusLine called (status cleared)", async () => {
            const ctx = createMockContext({ branch: [], hasUI: true });
            const setStatusSpy = vi.fn();
            ctx.ui!.setStatus = setStatusSpy;
            api._emit("session_start", {}, ctx);
            expect(setStatusSpy).toHaveBeenCalled();
            expect(setStatusSpy).toHaveBeenCalledWith("goal", undefined);
        });
        it("no persisted goal → no explicit goal hint message sent", async () => {
            const ctx = createMockContext({ branch: [], hasUI: true });
            api._emit("session_start", {}, ctx);
            const hints = api._messages.filter((m: any) => m.msg.customType === "goal-explicit-create-hint");
            expect(hints).toHaveLength(0);
        });
        it("persisted active goal → status line set, NO resume prompt", async () => {
            const goal = makeSnapshot("active");
            const branch = [makeSnapshotEntry(goal)];
            const ctx = createMockContext({ branch, hasUI: true });
            const setStatusSpy = vi.fn();
            ctx.ui!.setStatus = setStatusSpy;
            api._emit("session_start", {}, ctx);
            expect(setStatusSpy).toHaveBeenCalled();
            const statusCall = setStatusSpy.mock.calls.find(([key]) => key === "goal");
            expect(statusCall).toBeDefined();
            expect(statusCall![1]).not.toBeUndefined();
            const resumePrompts = api._messages.filter((m: any) => m.msg.customType === "goal-resume-prompt");
            expect(resumePrompts).toHaveLength(0);
            const explicitHints = api._messages.filter((m: any) => m.msg.customType === "goal-explicit-create-hint");
            expect(explicitHints).toHaveLength(0);
        });
        it("persisted paused goal → resume prompt message sent (customType=goal-resume-prompt, display=true)", async () => {
            const goal = makeSnapshot("paused", { tokensUsed: 10000, timeUsedSeconds: 300 });
            const branch = [makeSnapshotEntry(goal)];
            const ctx = createMockContext({ branch, hasUI: true });
            api._emit("session_start", {}, ctx);
            const resumePrompts = api._messages.filter((m: any) => m.msg.customType === "goal-resume-prompt");
            expect(resumePrompts).toHaveLength(1);
            expect(resumePrompts[0].msg.display).toBe(true);
        });
        it("persisted paused goal → ui.notify called", async () => {
            const goal = makeSnapshot("paused", { tokensUsed: 10000, timeUsedSeconds: 300 });
            const branch = [makeSnapshotEntry(goal)];
            const ctx = createMockContext({ branch, hasUI: true });
            const notifySpy = vi.fn();
            ctx.ui!.notify = notifySpy;
            api._emit("session_start", {}, ctx);
            expect(notifySpy).toHaveBeenCalled();
        });
        it("resume prompt message contains objective, status, tokens, time, and instructions", async () => {
            const goal = makeSnapshot("paused", {
                objective: "Build the feature",
                tokenBudget: 40000,
                tokensUsed: 20000,
                timeUsedSeconds: 600,
            });
            const branch = [makeSnapshotEntry(goal)];
            const ctx = createMockContext({ branch, hasUI: true });
            api._emit("session_start", {}, ctx);
            const resumePrompts = api._messages.filter((m: any) => m.msg.customType === "goal-resume-prompt");
            expect(resumePrompts).toHaveLength(1);
            const content: string = resumePrompts[0].msg.content;
            expect(content).toContain("Build the feature");
            expect(content).toContain("paused");
            expect(content).toContain("20k");
            expect(content).toContain("/goal resume");
            expect(content).toContain("/goal clear");
        });
        it("paused goal → NO continuation trigger", async () => {
            const goal = makeSnapshot("paused");
            const branch = [makeSnapshotEntry(goal)];
            const ctx = createMockContext({ branch, hasUI: true });
            api._emit("session_start", {}, ctx);
            const continuations = api._messages.filter((m: any) => m.opts?.triggerTurn === true);
            expect(continuations).toHaveLength(0);
        });
    });
    describe("runtime lifecycle hooks", () => {
        it('"turn_end" handler accepts event and context', async () => {
            const ctx = createMockContext({ branch: [], hasUI: true });
            const handler = api._listeners["turn_end"][0];
            const mockEvent: TurnEndEvent = {
                type: "turn_end",
                message: { usage: { input: 100, cachedInput: 20, output: 50 } },
                toolResults: [],
            } as any;
            expect(() => handler(mockEvent, ctx)).not.toThrow();
        });
        it('"agent_end" handler accepts event and context', async () => {
            const ctx = createMockContext({ branch: [], hasUI: true });
            const handler = api._listeners["agent_end"][0];
            expect(() => handler({ type: "agent_end" }, ctx)).not.toThrow();
        });
        it('"session_shutdown" handler calls applyStatusLine via onSessionShutdown', async () => {
            const ctx = createMockContext({ branch: [], hasUI: true });
            const setStatusSpy = vi.fn();
            ctx.ui!.setStatus = setStatusSpy;
            const handler = api._listeners["session_shutdown"][0];
            handler({}, ctx);
            expect(setStatusSpy).toHaveBeenCalled();
        });
    });
});
