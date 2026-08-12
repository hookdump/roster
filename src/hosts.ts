/**
 * Seats on other machines.
 *
 * Overton federates over HTTP because a plan window belongs to an *account* and
 * every machine spends from the same one, so there is a single authority worth
 * asking. Roster is the opposite: a seat is credentials *on a machine*. The same
 * subscription exists twice — a Keychain item here, a file on the server — and
 * resolving one remotely would hand you a path that does not exist locally next
 * to credentials that are not there either.
 *
 * So Roster does not point at a server. It *reports* on several machines, and
 * the transport is SSH rather than a daemon: Roster has no listener and should
 * not grow one. It sits beside credentials, so a network service would be a
 * liability bought for nothing — the trust to reach these hosts already exists,
 * and `ssh host roster ls --json` is the whole protocol.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { rosterHome, type Seat } from "./seats.ts";
import type { SeatStatus } from "./detect.ts";

export interface Host {
  name: string;
  /** What to hand ssh — a Host alias from ~/.ssh/config, or user@address. */
  ssh: string;
}

export const LOCAL = "local";

export function loadHosts(): Host[] {
  const file = join(rosterHome(), "seats.yaml");
  if (!existsSync(file)) return [];
  try {
    const doc = parseYaml(readFileSync(file, "utf8")) as Record<string, unknown>;
    const block = doc?.hosts;
    if (!block || typeof block !== "object") return [];
    return Object.entries(block as Record<string, any>)
      .map(([name, v]) => ({ name, ssh: typeof v === "string" ? v : String(v?.ssh ?? name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export interface RemoteSeat {
  host: string;
  seat: Seat;
  status: SeatStatus;
}

export interface HostResult {
  host: string;
  seats: RemoteSeat[];
  /** Set when the host could not be reached or did not answer usefully. */
  error?: string;
}

/**
 * Ask one machine what seats it has.
 *
 * A host that is asleep, off the tailnet, or missing the binary must degrade to
 * one legible row rather than taking the whole command down — the answer for
 * every other machine is still worth having, and "unreachable" is itself the
 * status you wanted to know.
 */
export function queryHost(host: Host, timeoutSec = 12): HostResult {
  const r = spawnSync(
    "ssh",
    [
      "-o", `ConnectTimeout=${Math.max(3, Math.floor(timeoutSec / 2))}`,
      "-o", "BatchMode=yes",
      host.ssh,
      // Set PATH explicitly rather than trusting a login shell. Which rc file
      // exports bun depends on the remote's shell — a zsh user's ~/.zshrc is
      // invisible to `bash -lc`, which is precisely how this first failed.
      'PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH" roster ls --json',
    ],
    { encoding: "utf8", timeout: timeoutSec * 1000 },
  );

  if (r.error) return { host: host.name, seats: [], error: `ssh failed: ${r.error.message}` };
  if (r.status !== 0) {
    const why = (r.stderr || "").trim().split("\n").pop() || `ssh exited ${r.status}`;
    return { host: host.name, seats: [], error: why.slice(0, 120) };
  }
  try {
    const parsed = JSON.parse(r.stdout) as Array<Seat & { status: SeatStatus }>;
    return {
      host: host.name,
      seats: parsed.map((s) => ({ host: host.name, seat: s, status: s.status })),
    };
  } catch {
    return { host: host.name, seats: [], error: "did not return JSON — is roster installed there?" };
  }
}

/** Every configured host, queried concurrently — one slow machine must not serialise the rest. */
export function queryHosts(hosts: Host[]): HostResult[] {
  // spawnSync is synchronous by necessity here (the CLI is sync throughout), so
  // this is sequential. With a handful of machines the ConnectTimeout bound is
  // what matters, not the concurrency.
  return hosts.map((h) => queryHost(h));
}
