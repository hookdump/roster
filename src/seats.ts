/**
 * A seat is a named subscription identity: which provider, whose credentials,
 * and where they live on this machine.
 *
 * There is no "current" seat. Every command names the one it wants, so two
 * agents can hold two seats at once — which is the whole point, and the thing
 * a switcher cannot do.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export type Provider = "anthropic" | "codex" | "unmetered";

export interface Seat {
  name: string;
  provider: Provider;
  /** CLAUDE_CONFIG_DIR for anthropic seats. */
  configDir?: string;
  /** CODEX_HOME for codex seats. */
  codexHome?: string;
  /** Declared plan, if the config says. The meter is the authority, not this. */
  plan?: string;
  /** Where this seat's definition came from, for `roster ls --json` and doctor. */
  source: string;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

export function rosterHome(): string {
  return process.env.ROSTER_HOME ? expandHome(process.env.ROSTER_HOME) : join(homedir(), ".roster");
}

export function overtonConfigPath(): string {
  return process.env.OVERTON_CONFIG
    ? expandHome(process.env.OVERTON_CONFIG)
    : join(homedir(), ".overton", "config.yaml");
}

function normaliseProvider(raw: unknown): Provider | null {
  const v = String(raw ?? "").toLowerCase();
  if (v === "anthropic" || v === "claude") return "anthropic";
  if (v === "codex" || v === "openai") return "codex";
  if (v === "unmetered" || v === "ollama" || v === "local") return "unmetered";
  return null;
}

/**
 * Read seats from an `accounts:`-shaped mapping. Overton's config and Roster's
 * own seats.yaml use the same shape on purpose: one registry, two readers.
 */
function seatsFromAccounts(accounts: unknown, source: string): Seat[] {
  if (!accounts || typeof accounts !== "object") return [];
  const out: Seat[] = [];
  for (const [name, rawValue] of Object.entries(accounts as Record<string, unknown>)) {
    const value = (rawValue ?? {}) as Record<string, unknown>;
    const provider = normaliseProvider(value.provider);
    if (!provider) continue;
    const configDir = value.config_dir ?? value.configDir;
    const codexHome = value.codex_home ?? value.codexHome;
    out.push({
      name,
      provider,
      configDir: typeof configDir === "string" ? expandHome(configDir) : undefined,
      codexHome: typeof codexHome === "string" ? expandHome(codexHome) : undefined,
      plan: typeof value.plan === "string" ? value.plan : undefined,
      source,
    });
  }
  return out;
}

export interface LoadResult {
  seats: Seat[];
  /** Every file actually read, in precedence order — `roster doctor` prints these. */
  sources: string[];
  warnings: string[];
}

/**
 * Seats come from Roster's own file if you keep one, and from Overton's
 * `accounts:` block otherwise. Running both, Roster's file wins per-name —
 * so you can override one seat without copying the whole registry.
 */
export function loadSeats(): LoadResult {
  const sources: string[] = [];
  const warnings: string[] = [];
  const byName = new Map<string, Seat>();

  const overtonPath = overtonConfigPath();
  if (existsSync(overtonPath)) {
    try {
      const doc = parseYaml(readFileSync(overtonPath, "utf8")) as Record<string, unknown>;
      for (const seat of seatsFromAccounts(doc?.accounts, overtonPath)) byName.set(seat.name, seat);
      sources.push(overtonPath);
    } catch (err) {
      warnings.push(`could not parse ${overtonPath}: ${(err as Error).message}`);
    }
  }

  const ownPath = join(rosterHome(), "seats.yaml");
  if (existsSync(ownPath)) {
    try {
      const doc = parseYaml(readFileSync(ownPath, "utf8")) as Record<string, unknown>;
      const block = doc?.seats ?? doc?.accounts;
      for (const seat of seatsFromAccounts(block, ownPath)) byName.set(seat.name, seat);
      sources.push(ownPath);
    } catch (err) {
      warnings.push(`could not parse ${ownPath}: ${(err as Error).message}`);
    }
  }

  const seats = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { seats, sources, warnings };
}

export function findSeat(name: string): Seat {
  const { seats, sources } = loadSeats();
  const seat = seats.find((s) => s.name === name);
  if (seat) return seat;
  const known = seats.map((s) => s.name).join(", ") || "(none)";
  const where = sources.length ? sources.join(", ") : "no seat file found";
  throw new Error(`unknown seat "${name}"\n  known seats: ${known}\n  read from:   ${where}`);
}

/**
 * The environment that makes a command run AS this seat. This is the whole
 * product in four lines: name a seat, get its environment, exec.
 */
export function seatEnv(seat: Seat): Record<string, string> {
  if (seat.provider === "anthropic" && seat.configDir) return { CLAUDE_CONFIG_DIR: seat.configDir };
  if (seat.provider === "codex" && seat.codexHome) return { CODEX_HOME: seat.codexHome };
  return {};
}

/** Where this seat's credentials live, for detection and for error messages. */
export function seatDir(seat: Seat): string | undefined {
  return seat.provider === "anthropic" ? seat.configDir : seat.provider === "codex" ? seat.codexHome : undefined;
}

/**
 * Make a seat's directory, if it has one and it is not there yet.
 *
 * Both engines refuse to start when their home points somewhere that does not
 * exist — codex fails outright with "CODEX_HOME points to …, but that path
 * does not exist". So `roster login` was the only command that could not run
 * against a seat that had never been used, while `roster run` told you to fix
 * exactly that by running `roster login`. Creating a seat IS what login means
 * here, so this belongs on that path and nowhere else.
 *
 * 0700 because what lands in here is an auth token.
 *
 * Separated from `cmdLogin` so it can be tested without spawning a real engine
 * and starting somebody's browser-based sign-in.
 */
export function ensureSeatDir(seat: Seat): { dir?: string; created: boolean; error?: string } {
  const dir = seatDir(seat);
  if (!dir) return { created: false };
  if (existsSync(dir)) return { dir, created: false };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { dir, created: true };
  } catch (e) {
    return { dir, created: false, error: (e as Error).message };
  }
}
