import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import formbody from "@fastify/formbody";
import cookie from "@fastify/cookie";
import ejs from "ejs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as db from "./db.js";
import * as scenarios from "./scenarios.js";
import { validateAddress, type AddressInput } from "./validate.js";

const VIEWS = path.join(path.dirname(fileURLToPath(import.meta.url)), "views");

type Session = { operator: string; createdAt: number };
const sessions = new Map<string, Session>();

async function render(view: string, locals: Record<string, unknown>): Promise<string> {
  const body = await ejs.renderFile(path.join(VIEWS, `${view}.ejs`), locals);
  return ejs.renderFile(path.join(VIEWS, "layout.ejs"), { ...locals, body });
}

function sessionOf(req: FastifyRequest): Session | undefined {
  const sid = req.cookies["dbsid"];
  if (!sid) return undefined;
  const s = sessions.get(sid);
  if (!s) return undefined;
  if (scenarios.consumeExpiry()) {
    sessions.delete(sid);
    return undefined;
  }
  const ttlMs = scenarios.get().session_ttl * 1000;
  if (Date.now() - s.createdAt > ttlMs) {
    sessions.delete(sid);
    return undefined;
  }
  return s;
}

function addressFrom(body: Record<string, unknown>): AddressInput {
  const s = (k: string) => String(body[k] ?? "");
  return { line1: s("line1"), line2: s("line2"), city: s("city"), state: s("state"), zip: s("zip") };
}

export function build(): FastifyInstance {
  const app = Fastify({ logger: false });
  const conn = db.open();

  app.register(formbody);
  app.register(cookie);

  /** Every business route requires a live session; expiry sends you back to login. */
  const requireSession = async (req: FastifyRequest, reply: FastifyReply): Promise<Session | null> => {
    const s = sessionOf(req);
    if (s) return s;
    reply
      .code(401)
      .type("text/html")
      .send(
        await render("error", {
          title: "Session expired",
          operator: null,
          heading: "Your session has expired",
          message: "Sign in again to continue. Unsaved changes were not submitted.",
        }),
      );
    return null;
  };

  app.get("/", async (req, reply) => {
    // Resolved once: calling sessionOf twice would consume the session check
    // twice and can dereference a session that expired between the two calls.
    const session = sessionOf(req);
    if (!session) return reply.redirect("/login");
    return reply.type("text/html").send(
      await render("search", {
        title: "Member search",
        operator: session.operator,
        q: "",
        searched: false,
        results: [],
      }),
    );
  });

  app.get("/login", async (_req, reply) =>
    reply.type("text/html").send(await render("login", { title: "Sign in", operator: null, error: null })),
  );

  app.post("/login", async (req, reply) => {
    const body = req.body as Record<string, string>;
    const ok =
      body.username === (process.env.DEMOBANK_USER ?? "operator") &&
      body.password === (process.env.DEMOBANK_PASS ?? "demo-pass-4417");
    if (!ok) {
      return reply
        .code(401)
        .type("text/html")
        .send(
          await render("login", {
            title: "Sign in",
            operator: null,
            error: "Username or password is incorrect.",
          }),
        );
    }
    const sid = randomUUID();
    sessions.set(sid, { operator: body.username!, createdAt: Date.now() });
    return reply.setCookie("dbsid", sid, { path: "/", httpOnly: true }).redirect("/");
  });

  app.get("/search", async (req, reply) => {
    const s = await requireSession(req, reply);
    if (!s) return reply;
    const q = String((req.query as Record<string, unknown>).q ?? "").trim();
    // Transient loading: the page still returns, but late, so replay must wait
    // for the results region rather than assume it is present.
    if (scenarios.get().slow_search) await new Promise((r) => setTimeout(r, 2600));
    return reply.type("text/html").send(
      await render("search", {
        title: "Member search",
        operator: s.operator,
        q,
        searched: true,
        results: q ? db.searchMembers(conn, q) : [],
      }),
    );
  });

  app.get("/members/:id", async (req, reply) => {
    const s = await requireSession(req, reply);
    if (!s) return reply;
    const id = (req.params as { id: string }).id;
    const m = db.getMember(conn, id);
    if (!m) {
      return reply.code(404).type("text/html").send(
        await render("error", {
          title: "Member not found",
          operator: s.operator,
          heading: "Member not found",
          message: `No member matches the identifier ${id}.`,
        }),
      );
    }
    const notice = (req.query as Record<string, unknown>).updated ? "Mailing address updated." : null;
    return reply
      .type("text/html")
      .send(await render("details", { title: `Member ${id}`, operator: s.operator, m, notice }));
  });

  app.get("/members/:id/edit", async (req, reply) => {
    const s = await requireSession(req, reply);
    if (!s) return reply;
    const id = (req.params as { id: string }).id;
    if (scenarios.get().force_403) {
      return reply.code(403).type("text/html").send(
        await render("error", {
          title: "Not permitted",
          operator: s.operator,
          heading: "You do not have permission to edit this member",
          message: "Address changes for this member require a supervisor role.",
        }),
      );
    }
    const m = db.getMember(conn, id);
    if (!m) return reply.code(404).type("text/html").send(
      await render("error", {
        title: "Member not found", operator: s.operator,
        heading: "Member not found", message: `No member matches the identifier ${id}.`,
      }),
    );
    return reply.type("text/html").send(
      await render("edit", {
        title: "Edit mailing address",
        operator: s.operator,
        m,
        v: { line1: m.line1, line2: m.line2, city: m.city, state: m.state, zip: m.zip },
        errors: {},
      }),
    );
  });

  app.post("/members/:id/review", async (req, reply) => {
    const s = await requireSession(req, reply);
    if (!s) return reply;
    const id = (req.params as { id: string }).id;
    const m = db.getMember(conn, id);
    if (!m) return reply.code(404).type("text/html").send(
      await render("error", {
        title: "Member not found", operator: s.operator,
        heading: "Member not found", message: `No member matches the identifier ${id}.`,
      }),
    );
    const v = addressFrom(req.body as Record<string, unknown>);
    const errors = validateAddress(v);
    if (Object.keys(errors).length) {
      return reply
        .code(422)
        .type("text/html")
        .send(await render("edit", { title: "Edit mailing address", operator: s.operator, m, v, errors }));
    }
    return reply.type("text/html").send(
      await render("review", {
        title: "Review changes",
        operator: s.operator,
        m,
        v,
        extraDialog: scenarios.get().extra_dialog,
      }),
    );
  });

  app.post("/members/:id/submit", async (req, reply) => {
    const s = await requireSession(req, reply);
    if (!s) return reply;
    const id = (req.params as { id: string }).id;
    const m = db.getMember(conn, id);
    if (!m) return reply.code(404).type("text/html").send(
      await render("error", {
        title: "Member not found", operator: s.operator,
        heading: "Member not found", message: `No member matches the identifier ${id}.`,
      }),
    );
    const v = addressFrom(req.body as Record<string, unknown>);
    const errors = validateAddress(v);
    if (Object.keys(errors).length) {
      return reply
        .code(422)
        .type("text/html")
        .send(await render("edit", { title: "Edit mailing address", operator: s.operator, m, v, errors }));
    }
    db.updateAddress(conn, id, v);
    const confId = db.recordConfirmation(conn, id, `${v.line1}, ${v.city}, ${v.state} ${v.zip}`);
    return reply.redirect(`/confirmation/${confId}`);
  });

  app.get("/confirmation/:cid", async (req, reply) => {
    const s = await requireSession(req, reply);
    if (!s) return reply;
    const cid = (req.params as { cid: string }).cid;
    const row = conn.prepare("SELECT * FROM confirmations WHERE confirmation_id = ?").get(cid) as
      | { member_id: string; created_at: string }
      | undefined;
    if (!row) return reply.code(404).type("text/html").send(
      await render("error", {
        title: "Unknown confirmation", operator: s.operator,
        heading: "Unknown confirmation", message: `No record for ${cid}.`,
      }),
    );
    return reply.type("text/html").send(
      await render("confirmation", {
        title: "Confirmation",
        operator: s.operator,
        confirmationId: cid,
        memberId: row.member_id,
        createdAt: row.created_at,
      }),
    );
  });

  // --- Operator/test control surface. Never allowlisted for automation. ---
  app.post("/_admin/reset", async (_req, reply) => {
    db.reset(conn);
    scenarios.resetScenarios();
    sessions.clear();
    return reply.send({ ok: true, reset: true });
  });

  app.post("/_admin/scenario", async (req, reply) => {
    const { key, value } = req.body as { key?: string; value?: string };
    if (!key || value === undefined) return reply.code(400).send({ error: "key and value required" });
    try {
      return reply.send({ ok: true, scenarios: scenarios.set(key, value) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get("/_admin/scenario", async (_req, reply) => reply.send(scenarios.get()));

  /** Lets a test assert that a workflow wrote exactly once. */
  app.get("/_admin/confirmations", async (_req, reply) => {
    const rows = conn.prepare("SELECT confirmation_id, member_id FROM confirmations").all();
    return reply.send({ count: rows.length, rows });
  });

  app.get("/_admin/member/:id", async (req, reply) => {
    const m = db.getMember(conn, (req.params as { id: string }).id);
    return m ? reply.send(m) : reply.code(404).send({ error: "not found" });
  });

  app.addHook("onClose", async () => conn.close());
  return app;
}

export async function serve(port = Number(process.env.DEMOBANK_PORT ?? 4000)): Promise<FastifyInstance> {
  const app = build();
  const conn = db.open();
  const count = (conn.prepare("SELECT COUNT(*) AS n FROM members").get() as { n: number }).n;
  if (count === 0) db.reset(conn);
  conn.close();
  await app.listen({ port, host: "127.0.0.1" });
  return app;
}
