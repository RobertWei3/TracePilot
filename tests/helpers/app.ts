import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { loadPolicy } from "../../src/safety/index.js";
import type { Policy } from "../../src/contracts/index.js";

export type TestApp = {
  baseUrl: string;
  policy: Policy;
  profileDir: string;
  reset: () => Promise<void>;
  scenario: (key: string, value: string) => Promise<void>;
  member: (id: string) => Promise<Record<string, unknown> | null>;
  stop: () => Promise<void>;
};

/**
 * Boots a real DemoBank on an ephemeral port with its own database file, and
 * returns a policy rewritten to that origin. Tests exercise real locator
 * resolution and real waiting against a real browser -- mocking the surface
 * would only test the mock.
 */
export async function startApp(): Promise<TestApp> {
  const dir = mkdtempSync(path.join(tmpdir(), "tracepilot-test-"));
  process.env.DEMOBANK_DB = path.join(dir, "demobank.sqlite");
  process.env.DEMOBANK_USER = "operator";
  process.env.DEMOBANK_PASS = "demo-pass-4417";

  // Imported after DEMOBANK_DB is set, so the app opens the test database.
  const server = await import(`../../src/demobank/server.js?t=${Date.now()}`);
  const dbmod = await import(`../../src/demobank/db.js?t=${Date.now()}`);

  const app: FastifyInstance = server.build();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no ephemeral port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const seed = dbmod.open();
  dbmod.reset(seed);
  seed.close();

  const base = loadPolicy();
  const policy: Policy = { ...base, allowedOrigins: [baseUrl] };

  const post = async (route: string, body: unknown): Promise<void> => {
    const res = await fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${route} -> ${res.status} ${await res.text()}`);
  };

  return {
    baseUrl,
    policy,
    profileDir: path.join(dir, "profile"),
    reset: () => post("/_admin/reset", {}),
    scenario: (key, value) => post("/_admin/scenario", { key, value }),
    member: async (id) => {
      const res = await fetch(`${baseUrl}/_admin/member/${id}`);
      return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
    },
    stop: async () => {
      await app.close();
    },
  };
}

export const OPERATOR_SECRETS = {
  "demobank.operator.user": "operator",
  "demobank.operator.password": "demo-pass-4417",
};
