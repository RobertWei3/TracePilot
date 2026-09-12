import { DatabaseSync } from "node:sqlite";
import path from "node:path";

/**
 * Resolved per call, not at import.
 *
 * A module-level constant freezes whichever value the environment happened to
 * hold when this module was first loaded. That is invisible in normal use --
 * one process, one database -- and wrong the moment two instances of the app
 * exist in one process, which is exactly what a test suite does: every app
 * after the first would quietly open the first one's file.
 */
export function dbPath(): string {
  return process.env.DEMOBANK_DB ?? path.resolve("demobank.sqlite");
}

export type Member = {
  member_id: string;
  first_name: string;
  last_name: string;
  dob: string;
  plan: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  updated_at: string | null;
};

/** Synthetic members. Not derived from any real person or record. */
const SEED: Omit<Member, "updated_at">[] = [
  { member_id: "M-1002", first_name: "Dana", last_name: "Whitfield", dob: "1974-03-11", plan: "Premier Checking", line1: "418 Larkspur Way", line2: "", city: "Ashford", state: "OR", zip: "97213" },
  { member_id: "M-1007", first_name: "Marcus", last_name: "Oyelaran", dob: "1988-11-02", plan: "Basic Savings", line1: "77 Kestrel Court", line2: "Apt 3B", city: "Fernbank", state: "WA", zip: "98104" },
  { member_id: "M-1013", first_name: "Priya", last_name: "Raghunathan", dob: "1991-06-24", plan: "Premier Checking", line1: "2210 Alder Street", line2: "", city: "Cold Harbor", state: "ME", zip: "04101" },
  { member_id: "M-1021", first_name: "Dana", last_name: "Whitmore", dob: "1969-01-30", plan: "Money Market", line1: "9 Beauclerc Lane", line2: "Suite 400", city: "Ashford", state: "OR", zip: "97215" },
  { member_id: "M-1034", first_name: "Tobias", last_name: "Renfrew", dob: "1955-09-08", plan: "Retirement IRA", line1: "1500 Quarry Road", line2: "", city: "Millbrook", state: "VT", zip: "05401" },
  { member_id: "M-1042", first_name: "Aiko", last_name: "Sandoval", dob: "2000-12-19", plan: "Student Checking", line1: "63 Threadneedle Row", line2: "", city: "Fernbank", state: "WA", zip: "98109" },
];

export function open(): DatabaseSync {
  const db = new DatabaseSync(dbPath());
  db.exec(`
    CREATE TABLE IF NOT EXISTS members (
      member_id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, dob TEXT, plan TEXT,
      line1 TEXT, line2 TEXT, city TEXT, state TEXT, zip TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS confirmations (
      confirmation_id TEXT PRIMARY KEY, member_id TEXT, created_at TEXT, summary TEXT
    );
  `);
  return db;
}

/** Wipes mutable state and re-seeds. This is the reset command's whole job. */
export function reset(db: DatabaseSync): void {
  db.exec("DELETE FROM members; DELETE FROM confirmations;");
  const ins = db.prepare(
    `INSERT INTO members (member_id, first_name, last_name, dob, plan, line1, line2, city, state, zip, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  for (const m of SEED) {
    ins.run(m.member_id, m.first_name, m.last_name, m.dob, m.plan, m.line1, m.line2, m.city, m.state, m.zip);
  }
}

export function getMember(db: DatabaseSync, id: string): Member | undefined {
  return db.prepare("SELECT * FROM members WHERE member_id = ?").get(id) as Member | undefined;
}

export function searchMembers(db: DatabaseSync, q: string): Member[] {
  const like = `%${q}%`;
  return db
    .prepare(
      `SELECT * FROM members
       WHERE member_id LIKE ? OR last_name LIKE ? OR first_name LIKE ?
       ORDER BY member_id`,
    )
    .all(like, like, like) as Member[];
}

export function updateAddress(
  db: DatabaseSync,
  id: string,
  a: { line1: string; line2: string; city: string; state: string; zip: string },
): void {
  db.prepare(
    `UPDATE members SET line1=?, line2=?, city=?, state=?, zip=?, updated_at=? WHERE member_id=?`,
  ).run(a.line1, a.line2, a.city, a.state, a.zip, new Date().toISOString(), id);
}

const CONF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function recordConfirmation(db: DatabaseSync, memberId: string, summary: string): string {
  let id = "CONF-";
  for (let i = 0; i < 8; i++) id += CONF_ALPHABET[Math.floor(Math.random() * CONF_ALPHABET.length)];
  db.prepare("INSERT INTO confirmations VALUES (?, ?, ?, ?)").run(
    id, memberId, new Date().toISOString(), summary,
  );
  return id;
}
