<img width="500" height="500" alt="image" src="https://github.com/user-attachments/assets/3bbec593-501a-4a41-a516-d45348206b9a" />

# Pi North Star: `/goal` — Persistent Goal Continuation

Track and auto-continue toward a goal across multiple LLM turns.

```bash
/goal Refactor the auth module to use OAuth 2.0
```

The model auto-continues until the objective is met, paused, aborted, or the token budget is exhausted.

## Setup

```bash
pi install https://github.com/artur-shlyapnikov/pi-north-star
```

## Commands

| Command | Description |
|---|---|
| `/goal <objective>` | Create a new goal (≤ 4,000 chars) |
| `/goal` | Show current status |
| `/goal pause` | Pause the active goal |
| `/goal resume` | Resume a paused goal |
| `/goal resume --budget <N>` | Resume with a new token budget |
| `/goal replace [--budget <N>] <objective>` | Replace goal — resets tokens, time, and continuation sequence |
| `/goal clear` | Clear the current goal |
| `/goal budget <N\|none>` | Set the token budget; `none` removes it |
| `/goal verify` | Show current verifier policy |
| `/goal verify off\|warn\|enforce` | Set the verifier policy |

## Model tools

| Tool | Description |
|---|---|
| `get_goal` | Read the current goal + remaining budget |
| `update_goal(status="complete")` | Mark complete (only `"complete"` is accepted) |
| `clear_goal` | Cancel/abandon the current goal |

Goals are created **only** by explicit user command — never by the model. Goal tools are exposed only while a goal exists; in strict-allowlist setups they must be whitelisted explicitly. A successful `update_goal(complete)` returns `terminate: true`, which ends the agent's turn immediately.

## Status line

The footer chip is set whenever a goal is `active`:

- with budget: `goal: <phase> <tokensUsed>/<tokenBudget>` — e.g. `goal: executing 1200/5000`
- without budget: `goal: <phase>`

A card widget below the editor shows the objective (truncated to 160 chars), token usage in short form (`1.2k/5k`), and elapsed time. Chip and widget are cleared when no goal is active.

Phase is inferred each turn from the *successful* non-goal tool results:

| Phase | Trigger |
|---|---|
| `planning` | only read-only tools (`read`, `grep`, `find`, `ls`, `web_search`, `code_search`, `fetch_content`, `get_search_content`, `get_goal`), or no tools at all |
| `executing` | any write tool (`edit`, `write`), or any tool that isn't read-only or verify |
| `verifying` | any tool whose name contains `test`, `verify`, `build`, `lint`, or `typecheck` |
| `blocked` | every tool errored *and* none succeeded |

Goal tools (`get_goal`, `update_goal`, `clear_goal`) are excluded from phase inference, so a turn that only calls goal tools keeps the previous phase.

## Verifier (`/goal verify`)

Inspects tool evidence collected during the current user→agent cycle and gates `update_goal` against premature completion.

| Policy | Behavior |
|---|---|
| `off` (default) | No verification |
| `warn` | Warn on insufficient evidence, allow completion anyway |
| `enforce` | Block `update_goal` until evidence is sufficient |

In `enforce` mode, completion always requires:

- ≥ 1 evidence item
- ≥ 2 distinct evidence kinds
- at least one `file_change` *or* `test_run`
- at least one non-inspection kind (`file_change`, `test_run`, `command_output`, or `verification_tool`)

Evidence kinds:

| Kind | Source |
|---|---|
| `file_inspection` | `read`, `grep`, `find`, `ls` |
| `file_change` | `edit`, `write` |
| `test_run` | tool name contains `test` / `verify` / `build` / `lint` / `typecheck` |
| `command_output` | `bash`, `shell` |
| `verification_tool` | any other non-goal tool (e.g. `web_search`) |
| `goal_check` | `get_goal` |

Failed tool calls produce no evidence. `update_goal` and `clear_goal` themselves don't count as evidence.

## Continuation behavior

- **Continuation pump.** After every turn, while the goal is `active`, an invisible `pi.goal.continuation` prompt is sent to trigger the next turn. The pump stops when:
  - the goal is no longer `active` (completed, paused, aborted, cleared, budget-limited), or
  - a continuation turn called zero non-goal tools (**stalled** — the goal stays `active`, but no further continuation is queued; the next external trigger restarts the pump).
- **Continuation CAS.** Before dispatching a continuation, the runtime re-reads the snapshot from the branch and checks `(id, revision)` against what was captured when the trigger was queued. If the snapshot changed in the meantime, the continuation is silently dropped.
- **Budget.** When `tokensUsed >= tokenBudget`, the goal moves to `budget_limited` and the pump stops. A `pi.goal.budget_limit` steer asks the model to wrap up — but only while the agent is mid-turn. If the limit trips between turns, the steer waits for the next turn.
- **Abort.** Ctrl+C during an active goal pauses it with `pauseReason: "abort"` to prevent restart loops.
- **Completion audit.** The continuation prompt instructs the model to restate the objective as concrete deliverables and verify each against real files / tests / command output before calling `update_goal`. The objective is XML-escaped and wrapped in `<untrusted_objective>` tags to neutralize prompt-injection attempts in user-supplied objectives.
- **`.goal-plan.md` (advisory).** The continuation prompt asks the model to write a numbered checklist at the project root for multi-step goals. This is a prompt-level instruction only — nothing in the extension reads, writes, or validates the file.

## Session UX

- **No goal on session start.** No hint is sent — goal mode is explicit.
- **Paused goal on session start.** A `goal-resume-prompt` message shows the objective, status, tokens used, and elapsed time, with `/goal resume`, `/goal resume --budget <N>`, and `/goal clear` as next steps.
- **`goal.event` entries** are emitted on meaningful transitions (`created`, `replaced`, `updated`, `paused`, `resumed`, `completed`, `budget_limited`, `cleared`) — but not on routine `usage` accounting — so the TUI and other extensions can observe state changes in real time.

## Persistence & concurrency

- **Branch-local snapshots** stored via `pi.appendEntry("goal.snapshot", …)`. No edits to Pi core. Branch fork/clone inherits the latest snapshot per Pi's branch semantics.
- **Verifier policy** is persisted separately under `goal.verifier`; the last entry wins.
- **Single-process serialization.** All mutation paths — tool handlers, slash commands, accounting, continuation dispatch — flow through one `AsyncMutex` in `GoalRuntime`. Lifecycle bookkeeping (`turn_end` / `agent_end`) goes through a sequential queue under the same mutex. There is no cross-process locking.
- **Revision counter.** Every snapshot carries a monotonic `revision`, bumped on every persisted mutation. The **continuation dispatcher** uses revision for full CAS — it re-reads the branch and checks `(id, revision)` before sending. **In-process mutations** (commands, tool handlers) rely on the mutex plus an id-equality guard (`expectedGoalId`); they do not re-verify revision against the branch, since serialization already prevents in-flight collisions.
- **Migration.** Pre-P0 snapshots without `revision` are normalized to `1` on load.

## Known limitations

- **Single-process only.** No cross-process locking; concurrent Pi sessions on the same branch can race.
- **`terminate: true` on completion** requires Pi runtime support and assumes no other non-terminating tool results landed in the same batch as `update_goal`.
- **Strict tool allowlists** must explicitly whitelist `get_goal`, `update_goal`, and `clear_goal`.
- **Budget steer race.** If `tokensUsed` crosses the budget between turns, the `pi.goal.budget_limit` steer waits for the next turn (gated on `agentRunning`).
- **`.goal-plan.md` is advisory.** The continuation prompt asks for it but does not enforce it; the verifier (in `enforce` mode) is the only hard gate against premature completion.
