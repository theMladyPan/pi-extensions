# TODO

The board extension is retired: pi-studio owns the board, the cards, the children and the
threads now. This repository keeps no board code.

Retired on `dev`; the last tree that held it is on branch `archive/dashboard-extension`
(`dac4240`, `dashboard/` plus `docs/roadmap-board.md`). The roadmap that lived in
`docs/roadmap-board.md` moved with the work: pi-studio's `STATE.md` and `TODO.md` carry it.

## Left in this repository

- [ ] **Retire `delegate.ts`** — pi-studio spawns children as board threads, so a tool that
      shells out to a fresh pi process is a second path to the same place.
