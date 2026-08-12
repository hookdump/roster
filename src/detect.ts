/**
 * Is a seat signed in, and as whom?
 *
 * Two things make this less trivial than reading a file:
 *
 *   1. Claude Code stores credentials in the macOS **Keychain**, not on disk.
 *      There is no `.credentials.json` under a profile on a Mac. On Linux there
 *      is. So the same seat is detectable by different means per platform, and
 *      pretending otherwise produces a tool that reports every Mac seat as
 *      signed out.
 *
 *   2. Nothing here ever prints, copies or transmits a token. Detection reads
 *      expiry and identity only. Credentials are the one thing Roster will not
 *      move between machines — refresh tokens rotate, so two machines holding
 *      one token means whichever refreshes second is silently logged out.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { seatDir, type Seat } from "./seats.ts";

export interface SeatStatus {
  authenticated: boolean;
  /** "keychain" | "file" | "n/a" — where the credential lives, not what it is. */
  store: string;
  who?: string;
  plan?: string;
  expiresAt?: Date;
  detail?: string;
}

function decodeJwtEmail(token: string): string | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json) as Record<string, unknown>;
    const email = payload.email ?? payload.preferred_username ?? payload.sub;
    return typeof email === "string" ? email : undefined;
  } catch {
    return undefined;
  }
}

function anthropicFromFile(dir: string): SeatStatus | null {
  const file = join(dir, ".credentials.json");
  if (!existsSync(file)) return null;
  try {
    const oauth = (JSON.parse(readFileSync(file, "utf8")) as Record<string, any>)?.claudeAiOauth ?? {};
    const expiresAt = typeof oauth.expiresAt === "number" ? new Date(oauth.expiresAt) : undefined;
    return {
      authenticated: true,
      store: "file",
      plan: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : undefined,
      expiresAt,
      detail: expiresAt && expiresAt.getTime() < Date.now() ? "access token expired — it refreshes on next use" : undefined,
    };
  } catch (err) {
    return { authenticated: false, store: "file", detail: `unreadable: ${(err as Error).message}` };
  }
}

/**
 * On macOS the credential is a Keychain item, so presence is the most we can
 * cheaply establish without prompting for Keychain access — and prompting from
 * a status command would be rude. We report the store and stay honest about
 * what we do not know.
 */
function anthropicFromKeychain(seat: Seat): SeatStatus {
  const usedDefaultProfile = !seat.configDir || seat.configDir === join(process.env.HOME ?? "", ".claude");
  return {
    authenticated: usedDefaultProfile,
    store: "keychain",
    detail: usedDefaultProfile
      ? "macOS Keychain — run `roster whoami` for detail"
      : "macOS keeps Claude credentials in the Keychain, so presence cannot be read from the profile directory",
  };
}

function codexStatus(home: string): SeatStatus {
  const file = join(home, "auth.json");
  if (!existsSync(file)) return { authenticated: false, store: "file", detail: `no auth.json under ${home}` };
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    const tokens = doc?.tokens ?? {};
    if (!tokens.refresh_token) {
      return { authenticated: false, store: "file", detail: "auth.json has no refresh token" };
    }
    return {
      authenticated: true,
      store: "file",
      who: typeof tokens.id_token === "string" ? decodeJwtEmail(tokens.id_token) : undefined,
      detail: doc.last_refresh ? `last refresh ${String(doc.last_refresh).slice(0, 19)}` : undefined,
    };
  } catch (err) {
    return { authenticated: false, store: "file", detail: `unreadable: ${(err as Error).message}` };
  }
}

export function seatStatus(seat: Seat): SeatStatus {
  if (seat.provider === "unmetered") {
    return { authenticated: true, store: "n/a", detail: "unmetered — no credential to hold" };
  }
  const dir = seatDir(seat);
  if (!dir) {
    return { authenticated: false, store: "n/a", detail: "seat declares no credential directory" };
  }
  if (seat.provider === "codex") return codexStatus(dir);

  // anthropic: file on Linux, Keychain on macOS.
  const fromFile = anthropicFromFile(dir);
  if (fromFile) return fromFile;
  if (process.platform === "darwin") return anthropicFromKeychain(seat);
  return {
    authenticated: false,
    store: "file",
    detail: `no .credentials.json under ${dir} — sign in with \`roster login ${seat.name}\``,
  };
}

/** Last time this seat wrote a transcript — a cheap "is it actually in use". */
export function lastUsed(seat: Seat): Date | undefined {
  const dir = seatDir(seat);
  if (!dir) return undefined;
  const candidate = seat.provider === "anthropic" ? join(dir, "projects") : join(dir, "sessions");
  try {
    return existsSync(candidate) ? statSync(candidate).mtime : undefined;
  } catch {
    return undefined;
  }
}
