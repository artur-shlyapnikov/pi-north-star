# Pi North Star

Pi North Star is a Pi coding-agent extension that stores one goal in the
current session branch and starts another turn while that goal is active.

```text
/goal Refactor the auth module to use OAuth 2.0
```

The extension keeps the goal objective, status, token usage, elapsed time, and
continuation count in the session branch. It does not modify Pi core files.

## Install

Install the extension from GitHub:

```bash
pi install https://github.com/artur-shlyapnikov/pi-north-star
```

Then create a goal in a Pi session:

```text
/goal Add request validation to the user API
```

An objective must contain at least one non-whitespace character and may have
up to 4,000 characters.

## Commands

| Command | Effect |
| --- | --- |
| `/goal <objective>` | Create a goal. |
| `/goal --budget <N> <objective>` | Create a goal with a positive integer token budget. |
| `/goal` | Show the current goal. |
| `/goal pause` | Pause the active goal. |
| `/goal resume` | Resume a paused goal. |
| `/goal resume --budget <N>` | Resume and replace the token budget. |
| `/goal replace <objective>` | Replace the current goal and reset its counters. |
| `/goal replace --budget <N> <objective>` | Replace the goal with a token budget. |
| `/goal clear` | Remove the current goal. |
| `/goal budget <N>` | Set a positive integer token budget. |
| `/goal budget none` | Remove the token budget. |
| `/goal verify` | Show the verifier policy. |
| `/goal verify off\|warn\|enforce` | Set the verifier policy. |
| `/goal plan-file` | Show whether plan-file prompts are enabled. |
| `/goal plan-file on\|off` | Enable or disable plan-file prompts. |

When a goal exists, Pi also receives these tools:

| Tool | Use |
| --- | --- |
| `get_goal` | Read the objective, status, usage, and budget. |
| `update_goal` | Mark the active goal complete with `status="complete"`. |
| `clear_goal` | Cancel the current goal. |

`update_goal` accepts only `status="complete"`. The extension checks the
configured verifier policy before it accepts completion.

## Status and continuation

The goal status is one of `active`, `paused`, `complete`, or
`budget_limited`.

While the status is `active`, the extension sends a hidden continuation prompt
after a turn ends. The prompt includes the objective and current usage. It
asks Pi to inspect the current state, work on the next incomplete item, and
verify the result before calling `update_goal`.

Continuation stops when the goal is paused, completed, cleared, or limited by
its token budget. A continuation that calls no non-goal tools is treated as
stalled. The next external trigger can start the process again.

Pi North Star tracks these live phases in the status line:

| Phase | When it appears |
| --- | --- |
| `planning` | The turn only reads files or has no non-goal tool calls. |
| `executing` | The turn uses a write tool or another non-read-only tool. |
| `verifying` | A tool name contains `test`, `verify`, `build`, `lint`, or `typecheck`. |
| `blocked` | Every non-goal tool call fails. |

## Configuration

The repository includes `config.json`:

```json
{
  "verifierPolicy": "enforce",
  "planFileEnabled": true
}
```

`verifierPolicy` can be `off`, `warn`, or `enforce`. In `enforce` mode,
completion needs evidence from at least two evidence kinds, including a file
change or a verification result. `warn` reports missing evidence but allows
completion. `off` skips the check.

When `planFileEnabled` is true, the continuation prompt asks Pi to keep a
numbered checklist in `.goal-plan.md` at the project root. The file is
advisory. The extension does not read, validate, or enforce its contents.

## Persistence and limits

The extension appends `goal.snapshot` entries to the current Pi session
branch. A new snapshot contains a revision number, objective, status, usage,
timestamps, and continuation sequence. The verifier policy is read from and
written to the repository's `config.json`.

All mutations inside one process use an async mutex. The extension does not
lock across processes, so two Pi sessions can race when they write the same
branch.

Other limits are part of the current implementation:

- Completion uses Pi runtime support for `terminate: true`.
- Strict tool allowlists must include `get_goal`, `update_goal`, and
  `clear_goal`.
- If usage crosses the budget between turns, the budget-limit prompt waits
  until the next active turn.

## Development

The package uses Bun for its test script:

```bash
bun install
bun test
```

The package also includes `package-lock.json` for npm-compatible dependency
resolution. The extension entry point is `index.ts`.
