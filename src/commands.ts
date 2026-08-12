import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadSeats, findSeat, seatEnv, seatDir, rosterHome, overtonConfigPath, type Seat } from "./seats.ts";
import { seatStatus, lastUsed } from "./detect.ts";

const GREEN = "\x1b[32m", RED = "\x1b[31m", DIM = "\x1b[2m", BOLD = "\x1b[1m", OFF = "\x1b[0m";
const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (colour ? `${code}${s}${OFF}` : s);

function pad(s: string, n: number) {
  return s + " ".repeat(Math.max(0, n - s.length));
}

/** The default command for each provider, and the argv that signs one in. */
const ENGINE = {
  anthropic: { bin: "claude", loginArgs: ["/login"] },
  codex: { bin: "codex", loginArgs: ["login"] },
} as const;

export function cmdLs(json: boolean): number {
  const { seats, warnings } = loadSeats();
  if (json) {
    console.log(JSON.stringify(
      seats.map((s) => ({ ...s, status: seatStatus(s), lastUsed: lastUsed(s)?.toISOString() })),
      null, 2,
    ));
    return 0;
  }
  if (!seats.length) {
    console.log("no seats defined.");
    console.log(`  looked in ${overtonConfigPath()} and ${join(rosterHome(), "seats.yaml")}`);
    return 1;
  }
  const rows = seats.map((s) => {
    const st = seatStatus(s);
    return {
      name: s.name,
      provider: s.provider,
      who: st.who ?? (st.authenticated ? "—" : c(RED, "not signed in")),
      plan: st.plan ?? s.plan ?? "—",
      store: st.store,
      ok: st.authenticated,
    };
  });
  const w = (k: keyof (typeof rows)[0]) =>
    Math.max(k.length, ...rows.map((r) => String(r[k]).replace(/\x1b\[[0-9;]*m/g, "").length));
  const [wn, wp, ww, wl] = [w("name"), w("provider"), w("who"), w("plan")];
  console.log(c(DIM, `  ${pad("SEAT", wn)}  ${pad("PROVIDER", wp)}  ${pad("AS", ww)}  ${pad("PLAN", wl)}  STORE`));
  for (const r of rows) {
    const mark = r.ok ? c(GREEN, "✓") : c(RED, "✗");
    const visibleWho = r.who.replace(/\x1b\[[0-9;]*m/g, "");
    console.log(
      `${mark} ${pad(r.name, wn)}  ${pad(r.provider, wp)}  ${r.who}${" ".repeat(Math.max(0, ww - visibleWho.length))}  ${pad(r.plan, wl)}  ${c(DIM, r.store)}`,
    );
  }
  for (const warn of warnings) console.error(c(RED, `  warning: ${warn}`));
  return 0;
}

export function cmdEnv(name: string, exportForm: boolean): number {
  const seat = findSeat(name);
  const env = seatEnv(seat);
  if (!Object.keys(env).length) {
    console.error(`seat "${name}" is ${seat.provider} — it needs no environment`);
    return 0;
  }
  for (const [k, v] of Object.entries(env)) console.log(exportForm ? `export ${k}=${JSON.stringify(v)}` : `${k}=${v}`);
  return 0;
}

export function cmdWhoami(name: string, json: boolean): number {
  const seat = findSeat(name);
  const st = seatStatus(seat);
  const used = lastUsed(seat);
  if (json) {
    console.log(JSON.stringify({ seat: seat.name, ...st, lastUsed: used?.toISOString() }, null, 2));
    return st.authenticated ? 0 : 1;
  }
  console.log(`${c(BOLD, seat.name)}  ${c(DIM, seat.provider)}`);
  console.log(`  signed in   ${st.authenticated ? c(GREEN, "yes") : c(RED, "no")}`);
  if (st.who) console.log(`  as          ${st.who}`);
  if (st.plan) console.log(`  plan        ${st.plan}`);
  console.log(`  credential  ${st.store}${seatDir(seat) ? c(DIM, `  (${seatDir(seat)})`) : ""}`);
  if (st.expiresAt) console.log(`  expires     ${st.expiresAt.toISOString().slice(0, 16).replace("T", " ")}`);
  if (used) console.log(`  last used   ${used.toISOString().slice(0, 16).replace("T", " ")}`);
  if (st.detail) console.log(c(DIM, `  ${st.detail}`));
  return st.authenticated ? 0 : 1;
}

/** Run a command as a seat. No global state is touched, so N of these run at once. */
export function cmdRun(name: string, argv: string[]): number {
  if (!argv.length) {
    console.error("nothing to run — put the command after `--`");
    return 2;
  }
  const seat = findSeat(name);
  const dir = seatDir(seat);
  if (dir && !existsSync(dir)) {
    console.error(`seat "${name}" points at ${dir}, which does not exist`);
    console.error(`  sign in first:  roster login ${name}`);
    return 78; // EX_CONFIG — waiting will not fix this
  }
  const child = spawnSync(argv[0]!, argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, ...seatEnv(seat) },
  });
  if (child.error) {
    console.error(`could not run ${argv[0]}: ${child.error.message}`);
    return 127;
  }
  return child.status ?? 0;
}

/** Sign a seat in, by running the engine's own login flow inside that seat. */
export function cmdLogin(name: string): number {
  const seat = findSeat(name);
  if (seat.provider === "unmetered") {
    console.error(`seat "${name}" is unmetered — nothing to sign in to`);
    return 0;
  }
  const engine = ENGINE[seat.provider];
  console.log(`signing in ${c(BOLD, seat.name)} — ${Object.entries(seatEnv(seat)).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(c(DIM, `  running: ${engine.bin} ${engine.loginArgs.join(" ")}`));
  const child = spawnSync(engine.bin, [...engine.loginArgs], {
    stdio: "inherit",
    env: { ...process.env, ...seatEnv(seat) },
  });
  if (child.error) {
    console.error(`could not run ${engine.bin}: ${child.error.message}`);
    return 127;
  }
  const after = seatStatus(seat);
  console.log(after.authenticated ? c(GREEN, "  signed in") : c(RED, "  still not signed in"));
  return after.authenticated ? 0 : 1;
}

export function cmdDoctor(): number {
  const { seats, sources, warnings } = loadSeats();
  console.log(c(DIM, "sources"));
  for (const s of sources) console.log(`  ${s}`);
  if (!sources.length) console.log(c(RED, "  none — no ~/.overton/config.yaml and no ~/.roster/seats.yaml"));
  for (const w of warnings) console.log(c(RED, `  ${w}`));
  console.log();
  let bad = 0;
  for (const seat of seats) {
    const st = seatStatus(seat);
    if (!st.authenticated) bad++;
    const mark = st.authenticated ? c(GREEN, "ok  ") : c(RED, "FAIL");
    console.log(`${mark} ${seat.name}${st.detail ? c(DIM, `  ${st.detail}`) : ""}`);
    if (!st.authenticated && seat.provider !== "unmetered") {
      console.log(c(DIM, `       fix: roster login ${seat.name}`));
    }
  }
  if (!seats.length) return 1;
  console.log();
  console.log(bad ? c(RED, `${bad} of ${seats.length} seats need signing in`) : c(GREEN, `all ${seats.length} seats ready`));
  return bad ? 1 : 0;
}

/**
 * Push CONFIG to another machine. Never credentials.
 *
 * Refresh tokens rotate: two machines holding one token means whichever
 * refreshes second is invalidated, and on an unattended fleet that reads as a
 * quota refusal at 3am. And on macOS there is no credential file to copy at
 * all — it is a Keychain item. So the seat map travels and the secrets do not;
 * `roster login` on the far side is a one-time cost that buys correctness.
 */
export function cmdSyncPush(host: string, dryRun: boolean): number {
  const files = [overtonConfigPath(), join(rosterHome(), "seats.yaml")].filter((f) => existsSync(f));
  if (!files.length) {
    console.error("nothing to push — no overton config and no seats.yaml");
    return 1;
  }
  console.log(`pushing seat config to ${c(BOLD, host)}${dryRun ? c(DIM, "  (dry run)") : ""}`);
  for (const f of files) console.log(`  ${f}`);
  console.log(c(DIM, "  credentials are never included — run `roster login` on the far side"));

  for (const f of files) {
    const remote = f.replace(process.env.HOME ?? "~", "~");
    const args = ["-av", ...(dryRun ? ["--dry-run"] : []), "--chmod=F600", f, `${host}:${remote}`];
    const r = spawnSync("rsync", args, { stdio: "inherit" });
    if (r.status !== 0) {
      console.error(c(RED, `  rsync failed for ${f}`));
      return r.status ?? 1;
    }
  }
  if (!dryRun) console.log(c(GREEN, "pushed") + c(DIM, `  next: ssh ${host} roster doctor`));
  return 0;
}
