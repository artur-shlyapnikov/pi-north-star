import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { GoalSnapshot, CapturedMessage, AppendedEntry } from "../../src/goal/goal-types";
import { GoalManager } from "../../src/goal/goal-manager";
import { GoalRuntime } from "../../src/runtime/goal-runtime";
export function makeGoalSnapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
    return {
        schemaVersion: 1,
        id: "goal-test-id",
        revision: 1,
        objective: "test goal",
        status: "active",
        tokenBudget: undefined,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        continuationSequence: 0,
        ...overrides,
    };
}
export function makeGoalSnapshotEntry(goal: GoalSnapshot, reason = "created"): SessionEntry {
    return {
        type: "custom",
        customType: "goal.snapshot",
        data: { reason, goal },
    } as unknown as SessionEntry;
}
export function makeBranchEntriesForGoal(goal: GoalSnapshot | null, reason = "stored"): SessionEntry[] {
    if (!goal)
        return [];
    return [makeGoalSnapshotEntry(goal, reason)];
}
export function flushMicrotasks(count = 1): Promise<void> {
    let p = Promise.resolve();
    for (let i = 0; i < count; i++) {
        p = p.then(() => new Promise((r) => setTimeout(r, 0)));
    }
    return p;
}
export function makeTurnEndEvent(overrides?: {
    toolResults?: {
        toolName: string;
        isError?: boolean;
    }[];
    usage?: {
        input: number;
        cachedInput: number;
        output: number;
    };
}): import("@earendil-works/pi-coding-agent").TurnEndEvent {
    const { toolResults = [], usage } = overrides ?? {};
    return {
        type: "turn_end",
        message: { usage: usage ?? { input: 0, cachedInput: 0, output: 0 } },
        toolResults,
    } as any;
}
export function makeExtensionContext(options?: {
    branchEntries?: SessionEntry[];
    hasUI?: boolean;
    aborted?: boolean;
    hasPendingMessages?: boolean;
    idle?: boolean;
    onStatus?: (key: string, text: string | undefined) => void;
    onWidget?: (key: string, lines: string[] | undefined, opts: {
        placement: string;
    }) => void;
    onNotify?: (message: string, level: "info" | "warning" | "error") => void;
}): ExtensionContext {
    return {
        sessionManager: {
            getBranch: () => options?.branchEntries ?? [],
        },
        ui: {
            setStatus: options?.onStatus ?? (() => { }),
            setWidget: options?.onWidget ?? (() => { }),
            notify: options?.onNotify ?? (() => { }),
        },
        hasUI: options?.hasUI ?? false,
        signal: { aborted: options?.aborted ?? false },
        hasPendingMessages: () => options?.hasPendingMessages ?? false,
        isIdle: () => options?.idle ?? true,
    } as unknown as ExtensionContext;
}
export interface MockApiResult {
    api: ExtensionAPI;
    entries: AppendedEntry[];
    branchEntries: SessionEntry[];
    messages: CapturedMessage[];
    tools: any[];
    commands: any[];
    listeners: Record<string, Function[]>;
    emit(event: string, ...args: unknown[]): void;
    activeTools: string[];
    setActiveTools(names: string[]): void;
    activeToolNames(): string[];
}
export function makeMockApi(options?: {
    allTools?: string[];
    activeTools?: string[];
}): MockApiResult {
    const entries: AppendedEntry[] = [];
    const branchEntries: SessionEntry[] = [];
    const messages: CapturedMessage[] = [];
    const tools: any[] = [];
    const commands: any[] = [];
    const listeners: Record<string, Function[]> = {};
    const activeTools: string[] = options?.activeTools ?? [];
    return {
        api: {
            appendEntry(type: string, data: unknown) {
                entries.push({ type, data });
                branchEntries.push({ type: "custom", customType: type, data } as unknown as SessionEntry);
            },
            sendMessage(msg: unknown, opts?: unknown) {
                messages.push({ msg, opts });
            },
            registerTool(def: any) {
                tools.push(def);
            },
            registerCommand(name: string, def: any) {
                commands.push({ name, def });
            },
            getAllTools: () => (options?.allTools ?? []).map((n) => ({ name: n })),
            getActiveTools: () => activeTools.map((n) => ({ name: n })),
            setActiveTools: (names: string[]) => {
                activeTools.length = 0;
                activeTools.push(...names);
            },
            on(event: string, handler: Function) {
                (listeners[event] ??= []).push(handler);
            },
        } as unknown as ExtensionAPI,
        entries,
        branchEntries,
        messages,
        tools,
        commands,
        listeners,
        emit(event: string, ...args: unknown[]) {
            (listeners[event] ?? []).forEach((h) => h(...args));
        },
        activeTools,
        setActiveTools(names: string[]) {
            activeTools.length = 0;
            activeTools.push(...names);
        },
        activeToolNames() {
            return activeTools.slice();
        },
    };
}
export interface RuntimeHarness {
    gm: GoalManager;
    runtime: GoalRuntime;
    api: ExtensionAPI;
    entries: AppendedEntry[];
    branchEntries: SessionEntry[];
    messages: CapturedMessage[];
    ctx: ExtensionContext;
}
export function makeRuntimeHarness(options?: {
    goal?: GoalSnapshot | null;
    persistGoal?: boolean;
    allTools?: string[];
    activeTools?: string[];
}): RuntimeHarness {
    const mock = makeMockApi({
        allTools: options?.allTools,
        activeTools: options?.activeTools,
    });
    const gm = new GoalManager();
    if (options?.goal) {
        gm.goal = options.goal;
        gm.refreshLiveStatusForGoalState();
    }
    if (options?.goal && options?.persistGoal !== false) {
        const SNAPSHOT_CUSTOM_TYPE = "goal.snapshot";
        mock.api.appendEntry(SNAPSHOT_CUSTOM_TYPE, { reason: "created", goal: options.goal });
    }
    const runtime = new GoalRuntime(mock.api, gm);
    const ctx: ExtensionContext = {
        sessionManager: { getBranch: () => mock.branchEntries },
        ui: { setStatus: () => { }, setWidget: () => { }, notify: () => { } },
        hasUI: false,
        signal: { aborted: false },
        hasPendingMessages: () => false,
        isIdle: () => true,
    } as unknown as ExtensionContext;
    return {
        gm,
        runtime,
        api: mock.api,
        entries: mock.entries,
        branchEntries: mock.branchEntries,
        messages: mock.messages,
        ctx,
    };
}
export async function drainRuntime(runtime: GoalRuntime, microtaskFlushes = 3): Promise<void> {
    await (runtime as unknown as {
        lifecycleTail: Promise<void>;
    }).lifecycleTail;
    await flushMicrotasks(microtaskFlushes);
}
export function findMessagesByCustomType(messages: CapturedMessage[], customType: string): CapturedMessage[] {
    return messages.filter((m) => (m.msg as any)?.customType === customType);
}
export function parseToolJsonResponse(response: unknown): unknown {
    const r = response as {
        content?: Array<{
            text: string;
        }>;
    };
    return JSON.parse(r.content?.[0]?.text ?? "{}");
}
