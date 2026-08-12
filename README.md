# Roster

**Multiple Claude and Codex seats, addressed by name.**

> A roster is the list of who is available to play. You do not *become* a player
> by crossing a name off it.

You have a personal Claude seat and a work one, a personal Codex seat and a work
one. Today that lives in shell functions, `CLAUDE_CONFIG_DIR` exports you copy
between machines, and a memory of which terminal is which.

```console
$ roster ls
  SEAT             PROVIDER   AS                  PLAN   STORE
✓ claude-personal  anthropic  —                   pro    file
✓ claude-work      anthropic  —                   team   file
✓ codex-personal   codex      hookdump@gmail.com  —      file
✗ codex-work       codex      not signed in       —      file

$ roster run claude-personal -- claude -p "fix #42"
$ roster run codex-work      -- codex exec "review this"
```

Both of those run **at the same time**, because naming a seat per invocation is
the whole design.

---

## Why not a switcher

Every other tool in this space switches: it mutates global state so that there
is a *current* account, atomically replacing live credentials. That model is
fine for a human at one keyboard and breaks the moment two agents need two seats
concurrently — which is the normal case as soon as anything is orchestrating
work for you.

Roster has no `use` command and no current seat. It resolves a name to an
environment and executes. Nothing global changes, so there is nothing to race.

## Install

```bash
git clone https://github.com/hookdump/roster
cd roster && bun install
ln -s "$PWD/bin/roster" ~/.local/bin/roster
```

Needs [Bun](https://bun.sh). Works on Linux and macOS.

## Seats come from a file you may already have

Roster reads the `accounts:` block of [Overton][overton]'s config if you run it,
and its own `~/.roster/seats.yaml` otherwise. Same shape either way — one
registry, two readers. Where both define a name, Roster's file wins, so you can
override a single seat without copying the whole thing.

```yaml
# ~/.roster/seats.yaml — or the accounts: block of ~/.overton/config.yaml
seats:
  claude-personal:
    provider: anthropic
    config_dir: ~/.claude-profiles/personal
  claude-work:
    provider: anthropic
    config_dir: ~/.claude-profiles/work
  codex-work:
    provider: codex
    codex_home: ~/.codex-profiles/work
```

## Commands

| | |
|---|---|
| `roster ls` | every seat, and whether it is signed in |
| `roster whoami <seat>` | who this seat is, its plan, when it was last used |
| `roster run <seat> -- <cmd>` | run a command as that seat |
| `roster env <seat>` | print its environment — for systemd units and wrappers |
| `roster login <seat>` | sign this seat in |
| `roster doctor` | what is configured, what still needs a login |
| `roster sync push <host>` | copy the seat map to another machine |

`run` returns the child's own exit code, so it composes in scripts.

## Credentials do not travel

`sync push` moves the **seat map**. It does not move credentials, and it never
will, for two independent reasons:

- **Refresh tokens rotate.** Two machines holding one refresh token means
  whichever refreshes second is invalidated. On an unattended fleet that
  surfaces at 3am as a failure indistinguishable from a quota refusal.
- **On macOS there is nothing to copy.** Claude Code keeps its credentials in
  the **Keychain**, not in a file under the profile directory. Mac→Linux would
  be a translation between undocumented storage backends, not a file copy.

So the config travels, `roster doctor` on the far side tells you which seats are
still unauthenticated, and `roster login` fixes them once. That is a smaller
cost than it looks, and it is correct.

## With Overton

[Overton][overton] answers a different question — *may this project spend on
this account right now?* — against real subscription plan windows. Roster
answers *who is this seat and how do I run as it?*

They compose in one direction: Overton may call Roster to resolve a seat, never
the reverse. Run either alone.

```console
$ roster run claude-personal -- claude -p "..."       # identity only
$ overton run sideproject claude-personal -- claude -p "..."   # gate, then identity
  wait 4h12m · sideproject is over its weekly allocation
```

Roster and Overton are the two halves of **Desk** — in an orchestra, a desk is
two players sharing one stand.

## License

MIT

[overton]: https://github.com/hookdump/overton
