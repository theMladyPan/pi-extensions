# Pi extensions

This repository is the source of truth for global Pi extensions. Clone it directly to `$HOME/.pi/agent/extensions`; Pi auto-discovers `*.ts` and `*/index.ts` files there.

## Install on a new workstation

Prerequisites: `git`, Pi, and GitHub SSH access to this repository.

```bash
git clone git@github.com:theMladyPan/pi-extensions.git "$HOME/.pi/agent/extensions"
```

If that directory already exists, do **not** clone over it. Inspect it first:

```bash
git -C "$HOME/.pi/agent/extensions" status
git -C "$HOME/.pi/agent/extensions" pull --ff-only
```

Restart Pi or run `/reload` after syncing.

## Sync

```bash
git -C "$HOME/.pi/agent/extensions" pull --ff-only
```

`--ff-only` refuses to overwrite local work. Commit, stash, or resolve local changes before pulling.

## Change and publish

```bash
cd "$HOME/.pi/agent/extensions"
git status
git add -A
git commit -m "feat(extensions): describe change"
git push
```

Run the relevant test before publishing:

```bash
(cd browser-screenshot && uv run test_runner.py)
node --experimental-strip-types --test next-steps/queue.test.ts
pi --list-models >/dev/null
```

## Notes for Pi agents

- This directory is a Git repository. Check `git status` before edits or pulls.
- Never commit credentials, authentication files, machine settings, session history, caches, or `node_modules`.
- Use `git pull --ff-only`; stop on conflicts or uncommitted changes.
- The `security.ts` extension requires the `security` skill at `$HOME/.agents/skills/security`.
