/**
 * Detection: is this seat actually signed in, and as whom.
 *
 * This is what `roster ls` and `roster doctor` print, so a wrong answer here
 * sends you to re-authenticate a seat that was fine — or worse, tells you a
 * seat is ready when the next dispatch will fail on it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastUsed, seatStatus } from "../src/detect.ts";
import type { Seat } from "../src/seats.ts";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "roster-detect-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const anthropic = (dir?: string): Seat =>
  ({ name: "a", provider: "anthropic", configDir: dir, source: "test" });
const codex = (dir?: string): Seat =>
  ({ name: "c", provider: "codex", codexHome: dir, source: "test" });

/** A dir that exists but holds no credential — the "never signed in" case. */
function emptyDir(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("seats with nothing to detect", () => {
  test("an unmetered seat is always ready and holds no credential", () => {
    const st = seatStatus({ name: "local", provider: "unmetered", source: "test" });
    expect(st.authenticated).toBe(true);
    expect(st.store).toBe("n/a");
  });

  test("a seat with no directory is not signed in, and says why", () => {
    const st = seatStatus(codex(undefined));
    expect(st.authenticated).toBe(false);
    expect(st.detail).toContain("no credential directory");
  });
});

describe("anthropic seats", () => {
  test("a valid credentials file reads as signed in, with the plan", () => {
    const dir = emptyDir("claude-ok");
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { subscriptionType: "max", expiresAt: Date.now() + 3_600_000 },
    }));

    const st = seatStatus(anthropic(dir));
    expect(st.authenticated).toBe(true);
    expect(st.store).toBe("file");
    expect(st.plan).toBe("max");
    expect(st.detail).toBeUndefined();
  });

  test("an expired token still counts as signed in, and says it refreshes", () => {
    // Reporting expiry as "not signed in" would send someone to redo a login
    // that the next call was going to refresh on its own.
    const dir = emptyDir("claude-expired");
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { subscriptionType: "pro", expiresAt: Date.now() - 60_000 },
    }));

    const st = seatStatus(anthropic(dir));
    expect(st.authenticated).toBe(true);
    expect(st.detail).toContain("refreshes");
  });

  test("a corrupt credentials file is reported, not thrown", () => {
    const dir = emptyDir("claude-corrupt");
    writeFileSync(join(dir, ".credentials.json"), "{ not json");

    const st = seatStatus(anthropic(dir));
    expect(st.authenticated).toBe(false);
    expect(st.detail).toContain("unreadable");
  });
});

describe("last used", () => {
  test("undefined when the seat has never written a transcript", () => {
    expect(lastUsed(anthropic(emptyDir("unused")))).toBeUndefined();
    expect(lastUsed(codex(emptyDir("unused-codex")))).toBeUndefined();
  });

  test("each provider looks in its own transcript directory", () => {
    const aDir = emptyDir("claude-used");
    mkdirSync(join(aDir, "projects"));
    expect(lastUsed(anthropic(aDir))).toBeInstanceOf(Date);

    const cDir = emptyDir("codex-used");
    mkdirSync(join(cDir, "sessions"));
    expect(lastUsed(codex(cDir))).toBeInstanceOf(Date);

    // And not in each other's — a codex seat with only `projects/` is unused.
    const wrong = emptyDir("codex-wrong");
    mkdirSync(join(wrong, "projects"));
    expect(lastUsed(codex(wrong))).toBeUndefined();
  });

  test("a seat with no directory has no last-used date", () => {
    expect(lastUsed(codex(undefined))).toBeUndefined();
  });
});
