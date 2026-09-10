/**
 * Operator CLI for the demo app. The scenario and reset commands talk to
 * /_admin, which the automation's safety policy deliberately does not
 * allowlist -- so only a human (or a test) can reach them.
 */
import { serve } from "./server.js";
import * as db from "./db.js";

const BASE = `http://127.0.0.1:${process.env.DEMOBANK_PORT ?? 4000}`;

async function adminPost(route: string, body: unknown): Promise<void> {
  const res = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res) {
    // Reset works offline too: fall back to operating the database directly.
    throw new Error(`DemoBank is not running at ${BASE}`);
  }
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  console.log(JSON.stringify(json, null, 2));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "serve": {
      const app = await serve();
      console.log(`DemoBank listening on ${BASE}`);
      process.on("SIGINT", () => void app.close().then(() => process.exit(0)));
      return;
    }
    case "reset": {
      try {
        await adminPost("/_admin/reset", {});
      } catch {
        // Offline path: reset the database in place without a running server.
        const conn = db.open();
        db.reset(conn);
        conn.close();
        console.log(JSON.stringify({ ok: true, reset: true, mode: "offline" }, null, 2));
      }
      return;
    }
    case "scenario": {
      const [sub, assignment] = rest;
      if (sub === "get") {
        const res = await fetch(`${BASE}/_admin/scenario`);
        console.log(JSON.stringify(await res.json(), null, 2));
        return;
      }
      if (sub !== "set" || !assignment?.includes("=")) {
        console.error("usage: demobank scenario set <key>=<value> | demobank scenario get");
        process.exitCode = 2;
        return;
      }
      const idx = assignment.indexOf("=");
      await adminPost("/_admin/scenario", {
        key: assignment.slice(0, idx),
        value: assignment.slice(idx + 1),
      });
      return;
    }
    default:
      console.error("usage: demobank serve | reset | scenario set <key>=<value> | scenario get");
      process.exitCode = 2;
  }
}

void main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exitCode = 1;
});
