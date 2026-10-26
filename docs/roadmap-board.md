# From a board that shows one session to a board that runs many

The dashboard today is a view of a single pi session. Its cards, activity rows and
totals live in the pi process (`dashboard/index.ts`, module scope), one `running`
flag assumes one agent, `outbox` and `awaitingTurns` assume one queue, and
`/reload` therefore costs the canvas.

The intent is a different thing: a durable workspace where work arrives as cards,
each card is a unit of work with a history and a provenance, several agents work at
once, and the human's attention is the scarce resource the layout serves.

This file is the order of work, not a specification. Each phase states what it
unlocks and why it sits where it does.

## Phases

| # | Phase | Unlocks | Rough size |
|---|---|---|---|
| 0 | Board state persisted and restored (cards, turns, activity, layout) | A reload, a crash or a restarted session no longer costs the canvas. Nothing later is safe without it | ~150 lines |
| 1 | `AgentRuntime` seam, written for its second implementation rather than ahead of it | The board stops depending on pi's event shape directly | part of phase 2 |
| 2 | Pi as a child over RPC: `prompt`, `steer`, `abort`, `compact`, live events | Delegate runs become steerable and abortable instead of fire-and-forget | ~300 lines |
| 3 | N concurrent runs keyed by card, per-card queues, the rail grouped per agent, `stop` targeting one run | The pivot from a view of one session to a model of many agents | ~400 lines, pervasive |
| 4 | Card verbs: fork from a card, re-run a task, compare two answers side by side, pin a card as a spec | A card becomes a unit of work rather than a message | ~300 lines |
| 5 | Provenance: card ↔ session ↔ tool calls ↔ commit | A card can say what it produced, which is what makes an agent board trustworthy | ~200 lines |

Order rationale: phase 0 makes 3 survivable, 2 makes 3 usable, 3 makes 4 meaningful
(forking a branch is pointless with one agent), and 5 is what makes the whole thing
credible to someone who is not its author.

## Decisions already made

- **The host owns the state; the browser renders SSE events.** No feature may put
  durable state in the client.
- **Pi stays underneath, behind a seam in the board.** Own harness only on evidence:
  hundreds of concurrent agents, work that is not a conversation, loop semantics pi
  will not expose, or a worker in another runtime. The tight child shape that a
  harness would give is already a launch configuration (`pi --mode rpc --no-session
  -ne -e ./card-agent.ts --tools read,grep,find,ls -n card-42 --system-prompt
  ./card-agent.md`).
- **Transport follows locality.** `--mode rpc` over stdio for local children, the
  SDK for in-process work, and a protocol of our own only when a worker is remote.
  gRPC is not an architectural choice here; it is what remote workers need.

## Deliberately out of scope for now

- Multi-user, authentication, hosting. A personal tool first.
- Rewriting `public/board.js` into a framework. Split it when phase 3 lands, not
  before.
- Making the board the only way to drive pi. The terminal stays a first-class client.
- Security hardening of the note renderer (SVG sanitiser, markdown link schemes) is
  tracked separately and is not blocked by this plan.

## Known limits of phase 0

- State is keyed by working directory, like the port and token in
  `~/.pi/agent/state/dashboard.json`. Two pi sessions in the same folder share one
  board file and the last writer wins.
- Activity detail payloads (arguments, logs, outputs) are not persisted: they are
  large and they describe work that has ended.
- Nothing is persisted about a run that was in flight. A restored board shows what
  had already finished.
