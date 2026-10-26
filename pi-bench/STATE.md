# pi-bench — where this stands

A standalone daemon that owns several pi agents side by side, with the board as
the workspace. It replaces the dashboard extension, which was a view of one pi
session and could never supervise more than one agent. Working name; the folder
moves when the name settles.

Read `../docs/roadmap-board.md` for why this exists and what each phase buys the
next one, and `../TODO.md` for the running status.

## Built and verified

- `server.mjs` (about 400 lines, Node builtins only, `node server.mjs`). It owns
  threads, spawns one `pi --mode rpc` child per thread, streams its events, and
  serves the board.
- Routes: `POST /thread` `{title?, folder?, model?}` → `{threadId}` (creates only,
  spawns nothing); `POST /message` `{threadId, text}` → spawns the thread's child
  if needed, sends the text as a `prompt` command, answers `{accepted:true}`;
  `GET /events` (SSE snapshot + `card`/`update`/`activity`); `GET /state` (JSON).
- Child argv: `node <pi cli> --mode rpc --no-session -ne --tools read,bash,edit,write
  --provider $PI_BENCH_PROVIDER --model $PI_BENCH_MODEL`, defaulting to
  `klotilda` / `deepseek-ai/DeepSeek-V4.1-Flash-1017`.
- Verified by curl on 2026-10-26: thread created, message accepted, child spawned,
  session id captured, reply (`pong`) landed on the thread's card, status `idle`,
  child gone once settled, and the daemon serves the client at `/`.

## Deliberately not built yet

- **The client is not wired to these routes.** `PUBLIC_DIR` points at
  `../dashboard/public/` on purpose: the board's client is settled and the daemon
  has to be what it talks to. The composer still posts the extension's shapes, so
  the `+` button and the per-thread send do not exist yet.
- No `abort`, no `steer` from the UI (the wire is proven in `delegate.ts`).
- No board verbs for children: they cannot draw notes, sources or questions yet.
- No persistence of threads or cards, so a daemon restart loses the board.
- No rail grouping per agent, no usage totals, no per-thread conversation view.

## Next slice, in order

1. Adapt the daemon's `/message` to what the established client already posts, and
   remove the global composer from the client in favour of the `+` button and a
   per-card send. This is a small diff against `dashboard/public/board.js`; the
   visuals do not change.
2. Board verbs over HTTP for children (`POST /card/note`, `/card/source`,
   `/card/ask`), plus a thin `slave.ts` extension a child loads with `-e` so it can
   draw on the board the way the dashboard extension does today.
3. Persistence: threads with their session ids, cards with their rects, so a
   restarted daemon resumes a thread by spawning a child on its session.
4. Steer and abort per thread, then N concurrent runs keyed by card.

## Rules for whoever continues

- The client is `dashboard/public/index.html` and `dashboard/public/board.js`. Do
  not write a second UI next to it.
- No subagent starts a browser or sends signals to processes. Verification is curl
  and `node --check`; anything visual is checked by the owner.
- One slice per commit, conventional commits, review before commit.
