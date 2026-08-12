#!/usr/bin/env bun
/**
 * roster — name a seat, run as it.
 *
 * Part of Desk. Its sibling, Overton, decides whether a seat may spend right
 * now; Roster decides nothing and only resolves identity. They share one
 * `accounts:` registry, so adopting either does not require adopting both.
 */
import { cmdLs, cmdEnv, cmdWhoami, cmdRun, cmdLogin, cmdDoctor, cmdSyncPush } from "./commands.ts";

const HELP = `roster — multiple Claude and Codex seats, addressed by name

  A seat is a named subscription identity. There is no "current" seat: every
  command names the one it wants, so several can run at once.

USAGE
  roster <command> [options]

SEATS
  ls                          every seat, and whether it is signed in
  whoami <seat>               who this seat is, and when it was last used
  doctor                      what is configured, what still needs a login

RUNNING
  run <seat> -- <cmd>...      run a command as that seat
  env <seat>                  print its environment (for wrappers, systemd)
  login <seat>                sign this seat in

MOVING
  sync push <host>            copy the seat map to another machine
                              config only — credentials never travel

OPTIONS
  --json                      machine-readable output (ls, whoami)
  --host <name>               only this machine (ls)
  --local                     skip other machines (ls)
  --export                    env prints \`export K=V\` (env)
  --dry-run                   show what sync would do
  -h, --help  -V, --version

OTHER MACHINES
  ls reports every machine in hosts: over ssh, marked by host. Seats are
  local by their nature — credentials live on a machine — so run, env and
  login always act here.

SEATS COME FROM
  ~/.overton/config.yaml      the accounts: block, if you run Overton
  ~/.roster/seats.yaml        Roster's own file; wins per-name where both exist

EXIT CODES
  0 ok · 1 not signed in / nothing to do · 2 usage · 78 seat misconfigured
  \`run\` returns the command's own exit code.
`;

const VERSION = "0.1.0";

function main(argv: string[]): number {
  // Everything after `--` belongs to the child, never to us.
  const sep = argv.indexOf("--");
  const mine = sep === -1 ? argv : argv.slice(0, sep);
  const rest = sep === -1 ? [] : argv.slice(sep + 1);

  const flags = new Set(mine.filter((a) => a.startsWith("-")));
  const words = mine.filter((a) => !a.startsWith("-"));
  const [command, ...args] = words;

  if (flags.has("-h") || flags.has("--help") || !command) {
    console.log(HELP);
    return command ? 0 : 2;
  }
  if (flags.has("-V") || flags.has("--version")) {
    console.log(VERSION);
    return 0;
  }

  const json = flags.has("--json");
  // --host e16 narrows to one machine; --local skips the network entirely.
  const hostIdx = mine.indexOf("--host");
  const hostFlag = hostIdx >= 0 ? mine[hostIdx + 1] : undefined;
  const need = (what: string): string => {
    if (!args[0]) throw new Error(`${command} needs ${what}\n  try: roster ${command} <${what}>`);
    return args[0];
  };

  switch (command) {
    case "ls":
    case "list":
      return cmdLs(json, {
        hostFilter: typeof hostFlag === "string" ? hostFlag : undefined,
        localOnly: flags.has("--local"),
      });
    case "env":
      return cmdEnv(need("seat"), flags.has("--export"));
    case "whoami":
      return cmdWhoami(need("seat"), json);
    case "run":
      return cmdRun(need("seat"), rest);
    case "login":
      return cmdLogin(need("seat"));
    case "doctor":
      return cmdDoctor();
    case "sync": {
      const [sub, host] = args;
      if (sub !== "push") throw new Error(`unknown sync subcommand "${sub ?? ""}"\n  only \`roster sync push <host>\` exists today`);
      if (!host) throw new Error("sync push needs a host\n  try: roster sync push ig-thinkpad-e16");
      return cmdSyncPush(host, flags.has("--dry-run"));
    }
    default:
      console.error(`unknown command "${command}"`);
      console.error("  run `roster --help` for the list");
      return 2;
  }
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
