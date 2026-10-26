# TODO

Where the board is on the way from a view of one session to a model of many
agents. The reasoning behind the order, and what each phase buys the next, is in
[`docs/roadmap-board.md`](docs/roadmap-board.md).

Ticked means in the repo. It does not mean exercised.

- [x] **0 · Persist and restore the board** — cards, turns, layout, newest rail rows
      in `~/.pi/agent/state/boards/`, restored on start, write debounced, flush on
      stop. `5597a8a`
- [x] **0 · Test it with a real `/reload`** — proven: the board came back with the
      sticky it held before the reload, at its saved rect, plus the rail rows that
      had finished. `be4d4c2bba814da6.json` in `~/.pi/agent/state/boards/`.
- [x] **2 · RPC transport for delegate children** — task as a `prompt` command, run
      ends on `agent_settled`, `abort` before the kill timer, `steer` proven on the
      wire. `843b040`
- [ ] **1 · `AgentRuntime` seam** — start, prompt, steer, abort, compact, events,
      usage. Written when the second implementation arrives, not ahead of it.
- [ ] **2 · A steer surface** — somewhere to type into a running card, because the
      wire has no button yet.
- [ ] **3 · N concurrent runs keyed by card** — per-card queues, rail grouped per
      agent, `stop` targeting one run. The pivot from a view of one session to a
      model of many agents.
- [ ] **3 · Split `board.js`** — it is 3000 lines and this phase touches it
      everywhere. Split when the phase lands, not before.
- [ ] **4 · Card verbs** — fork from a card, re-run a task, compare two answers side
      by side, pin a card as a spec.
- [ ] **5 · Provenance** — card ↔ session ↔ tool calls ↔ commit, so a card can say
      what it produced.

## pi-bench — board as master, pi as slaves

A standalone daemon that owns the agents, replacing the extension. Detail, proofs
and next slice: [`pi-bench/STATE.md`](pi-bench/STATE.md).

- [x] **Daemon vertical slice** — `pi-bench/server.mjs`: threads, one `--mode rpc`
      child per thread, `POST /thread`, `POST /message`, `GET /events`, `GET /state`.
      Verified by curl: message in, `pong` out, child gone when idle.
- [x] **Wire the established client** — the daemon speaks the client's routes; the
      client gained an opt-in `body.threads` layout (no bottom composer, a `+` button,
      the field docked in the card). The extension's board is untouched.
- [ ] **Board verbs for children** — `POST /card/note`, `/card/source`, `/card/ask`,
      plus a thin `slave.ts` a child loads with `-e`.
- [ ] **Persistence of threads** — session ids and cards, so a restarted daemon
      resumes a thread by spawning a child on its session.
- [ ] **Steer and abort per thread** — the wire is proven in `delegate.ts`.
- [ ] **Retire `delegate.ts`** — once pi-studio lands, a child spawns new cards and
      subagents on the board instead of calling a tool that shells out to a fresh pi
      process. `delegate.ts` goes away with that, and the board becomes the only way
      work is handed to another agent.

The two decisions that are expensive to revisit: the host owns the state and the
browser only renders events, and the runtime seam lives in the board rather than in
a fork of pi.

Still out of scope: multi-user and auth, a framework rewrite of the client, and
making the board the only way to drive pi.
