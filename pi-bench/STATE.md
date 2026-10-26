# pi-bench — where this stands

A standalone daemon that owns several pi agents side by side, with the board as
the workspace. It replaces the dashboard extension, which was a view of one pi
session and could never supervise more than one agent. Working name; the folder
moves when the name settles.

The product name is **pi-studio**; the folder is still `pi-bench/` from the first
slice and gets renamed when something depends on the name.

Retirement note: when pi-studio lands, `delegate.ts` is retired. A child will spawn
new cards and subagents on the board directly, so handing work to another agent
stops being a tool call that shells out to a fresh pi process and becomes something
the board itself does. That is what the board verbs in slice 2 are for.

Read `../docs/roadmap-board.md` for why this exists and what each phase buys the
next one, and `../TODO.md` for the running status.

## Built and verified

- `server.mjs` (about 470 lines, Node builtins only, `node server.mjs`). It owns threads,
  spawns one `pi --mode rpc` child per thread, streams its events, and serves the board.
- The daemon speaks the routes the established client already calls, so there is one client and
  no second UI: `GET /` `/board.js` `/events` `/browse` `/state` `/activity/<id>`, `POST /thread`
  `/message` `/layout` `/close` `/stop` (plus honest 409s for `/compact`, `/answer`, `/edit`).
- A thread is projected as the card the browser has always drawn: a sticky whose `title` is the
  thread name and whose `turns` are the exchanges, each with the answer attached when it lands.
- `meta.mode === "threads"` tells the shared client to lay itself out as a board of threads. The
  extension's one-session board does not send it, so its composer and layout are untouched.
- Client changes are opt-in under `body.threads`: the bottom composer is hidden, the canvas owns
  the whole height, and a `+` button sits bottom right. Pressing it creates a thread, centres it,
  docks the composer into it and focuses the field; the field stays docked after a send, because a
  thread is a conversation.
- Steering and queueing work per thread: `mode: "steer"` joins the run in flight, `mode: "queue"`
  waits behind it and is sent when the child settles. A turn redirected by a steer reads `stopped`
  rather than as a message still in flight.
- Verified by curl on 2026-10-26 against real children: fresh thread, reply (`pong`), a second
  message on the same thread (new child, reply `two`), a mid-run steer answered with `steered`,
  `/layout` storing a rect, `/stop` aborting a live run, `/close` removing thread and child,
  `/browse` listing a folder, 403 without a token, 404 for the rail's detail payloads, and
  `mode: "threads"` in the snapshot's meta.

## Deliberately not built yet

- No persistence: a daemon restart loses threads and cards.
- No board verbs for children: they cannot draw notes, sources or questions yet, so a thread can
  only answer in its own card.
- No live text in the card while the answer streams; the reply appears when the turn ends.
- No rail detail payloads (arguments, logs, outputs), no usage totals, no image attachments.
- One run per thread and no supervision view: the rail is one list, `stop` aborts every running
  thread rather than a chosen one.

## Next slice, in order

1. Board verbs over HTTP for children (`POST /card/note`, `/card/source`, `/card/ask`) plus a thin
   `slave.ts` a child loads with `-e`, so a thread can put things on the board instead of only
   answering.
2. Persistence: threads with their session ids and cards with their rects, so a restarted daemon
   resumes a thread by spawning a child on its session.
3. Per-thread stop and a rail grouped by thread, so several runs can be supervised.
4. Stream the answer into the card, then rail detail payloads.

## Rules for whoever continues

- The client is `dashboard/public/index.html` and `dashboard/public/board.js`. Do
  not write a second UI next to it.
- No subagent starts a browser or sends signals to processes. Verification is curl
  and `node --check`; anything visual is checked by the owner.
- One slice per commit, conventional commits, review before commit.
