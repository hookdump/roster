/**
 * Seats: the registry, the environment, and creating one.
 *
 * Both config paths are env-overridable (`OVERTON_CONFIG`, `ROSTER_HOME`),
 * which is what makes this testable against fixtures instead of against
 * whatever happens to be in the developer's home directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSeatDir, expandHome, findSeat, loadSeats, seatDir, seatEnv, type Seat,
} from "../src/seats.ts";

let tmp: string;
const saved = { overton: process.env.OVERTON_CONFIG, roster: process.env.ROSTER_HOME };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "roster-test-"));
  // Point both readers at the fixture dir so nothing reads the real registry.
  process.env.OVERTON_CONFIG = join(tmp, "overton.yaml");
  process.env.ROSTER_HOME = join(tmp, "roster");
});

afterEach(() => {
  saved.overton === undefined ? delete process.env.OVERTON_CONFIG : (process.env.OVERTON_CONFIG = saved.overton);
  saved.roster === undefined ? delete process.env.ROSTER_HOME : (process.env.ROSTER_HOME = saved.roster);
  rmSync(tmp, { recursive: true, force: true });
});

const writeOverton = (yaml: string) => writeFileSync(join(tmp, "overton.yaml"), yaml);
const writeRoster = (yaml: string) => {
  mkdirSync(join(tmp, "roster"), { recursive: true });
  writeFileSync(join(tmp, "roster", "seats.yaml"), yaml);
};

const seat = (over: Partial<Seat> = {}): Seat =>
  ({ name: "s", provider: "codex", source: "test", ...over }) as Seat;

describe("reading the registry", () => {
  test("seats come from overton's accounts block", () => {
    writeOverton(`
accounts:
  codex-personal:
    provider: codex
    codex_home: ${join(tmp, "codex-personal")}
  claude-work:
    provider: anthropic
    config_dir: ${join(tmp, "claude-work")}
`);
    const { seats, sources } = loadSeats();
    expect(seats.map((s) => s.name)).toEqual(["claude-work", "codex-personal"]);
    expect(sources).toEqual([join(tmp, "overton.yaml")]);
  });

  test("provider aliases normalise", () => {
    // The two registries are written by different hands; `claude` and
    // `anthropic` must mean the same seat, not one seat and one silent drop.
    writeOverton(`
accounts:
  a: { provider: claude, config_dir: /tmp/a }
  b: { provider: openai, codex_home: /tmp/b }
  c: { provider: ollama }
`);
    const byName = Object.fromEntries(loadSeats().seats.map((s) => [s.name, s.provider]));
    expect(byName).toEqual({ a: "anthropic", b: "codex", c: "unmetered" });
  });

  test("an unknown provider is skipped rather than guessed at", () => {
    writeOverton(`accounts:\n  weird: { provider: perplexity }\n  ok: { provider: codex }\n`);
    expect(loadSeats().seats.map((s) => s.name)).toEqual(["ok"]);
  });

  test("roster's own file wins per-name, so one seat can be overridden", () => {
    writeOverton(`accounts:\n  shared: { provider: codex, codex_home: /tmp/from-overton }\n  only-overton: { provider: codex }\n`);
    writeRoster(`seats:\n  shared: { provider: codex, codex_home: /tmp/from-roster }\n`);

    const { seats, sources } = loadSeats();
    expect(seats.find((s) => s.name === "shared")!.codexHome).toBe("/tmp/from-roster");
    // Overriding one seat must not drop the rest of the registry.
    expect(seats.map((s) => s.name)).toEqual(["only-overton", "shared"]);
    expect(sources).toHaveLength(2);
  });

  test("a malformed file warns instead of throwing", () => {
    // A broken registry must still let `roster doctor` run and say so.
    writeOverton("accounts: [this is: not, valid: mapping\n");
    const { warnings } = loadSeats();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("could not parse");
  });

  test("no files at all is empty, not an error", () => {
    const { seats, sources, warnings } = loadSeats();
    expect(seats).toEqual([]);
    expect(sources).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("an unknown seat names the ones that exist and where they came from", () => {
    writeOverton(`accounts:\n  codex-personal: { provider: codex }\n`);
    expect(() => findSeat("codex-personl")).toThrow(/codex-personal/);
    expect(() => findSeat("nope")).toThrow(/overton\.yaml/);
  });
});

describe("the environment that makes a command run as a seat", () => {
  test("each provider gets its own variable, and unmetered gets none", () => {
    expect(seatEnv(seat({ provider: "anthropic", configDir: "/tmp/a" }))).toEqual({ CLAUDE_CONFIG_DIR: "/tmp/a" });
    expect(seatEnv(seat({ provider: "codex", codexHome: "/tmp/c" }))).toEqual({ CODEX_HOME: "/tmp/c" });
    expect(seatEnv(seat({ provider: "unmetered" }))).toEqual({});
  });

  test("a seat with no directory contributes no environment", () => {
    // Otherwise a half-configured seat would export an empty path and the
    // engine would silently use the default profile — the one bug that makes
    // two seats quietly become one.
    expect(seatEnv(seat({ provider: "codex" }))).toEqual({});
    expect(seatDir(seat({ provider: "codex" }))).toBeUndefined();
  });

  test("~ expands, relative paths resolve", () => {
    expect(expandHome("~/x")).toStartWith("/");
    expect(expandHome("~/x")).toEndWith("/x");
    expect(expandHome("/already/absolute")).toBe("/already/absolute");
  });
});

describe("creating a seat directory", () => {
  test("makes the directory when it does not exist", () => {
    // The bug this fixes: codex refuses to start when CODEX_HOME points at a
    // path that is not there, so `roster login` could not create the very
    // seat it existed to create.
    const dir = join(tmp, "profiles", "personal");
    const made = ensureSeatDir(seat({ provider: "codex", codexHome: dir }));

    expect(made.created).toBe(true);
    expect(made.dir).toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  test("creates it 0700, because an auth token lands in it", () => {
    const dir = join(tmp, "secrets");
    ensureSeatDir(seat({ provider: "codex", codexHome: dir }));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("makes intermediate directories", () => {
    const dir = join(tmp, "a", "b", "c");
    expect(ensureSeatDir(seat({ provider: "anthropic", configDir: dir })).created).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  test("an existing directory is left alone and not reported as created", () => {
    const dir = join(tmp, "already");
    mkdirSync(dir);
    writeFileSync(join(dir, "auth.json"), "{}");

    const made = ensureSeatDir(seat({ provider: "codex", codexHome: dir }));
    expect(made.created).toBe(false);
    // The credential that was already there must survive a second login.
    expect(statSync(join(dir, "auth.json")).isFile()).toBe(true);
  });

  test("an unmetered seat has nothing to create", () => {
    expect(ensureSeatDir(seat({ provider: "unmetered" }))).toEqual({ created: false });
  });

  test("a directory it cannot create is reported, not thrown", () => {
    // cmdLogin turns this into EX_CANTCREAT rather than a stack trace.
    const made = ensureSeatDir(seat({ provider: "codex", codexHome: "/proc/nope/seat" }));
    expect(made.created).toBe(false);
    expect(made.error).toBeTruthy();
  });
});
