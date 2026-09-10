/**
 * Controllable failure scenarios. Toggled only via /_admin, which the safety
 * policy deliberately does not allowlist -- so the automation is structurally
 * incapable of changing them.
 */
export type Scenarios = {
  /** Session lifetime in seconds. Short values exercise session expiry. */
  session_ttl: number;
  /** Adds a transient loading delay plus a spinner to the search results. */
  slow_search: boolean;
  /** Forces 403 on the edit route, to exercise permission handling. */
  force_403: boolean;
  /** Adds a native confirm() dialog on submit, undeclared by any artifact. */
  extra_dialog: boolean;
};

const DEFAULTS: Scenarios = {
  session_ttl: 1800,
  slow_search: false,
  force_403: false,
  extra_dialog: false,
};

let current: Scenarios = { ...DEFAULTS };

export function get(): Scenarios {
  return current;
}

export function resetScenarios(): void {
  current = { ...DEFAULTS };
}

export function set(key: string, raw: string): Scenarios {
  if (!(key in DEFAULTS)) throw new Error(`unknown scenario: ${key}`);
  if (key === "session_ttl") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error("session_ttl must be a positive number");
    current = { ...current, session_ttl: n };
  } else {
    const on = raw === "on" || raw === "true" || raw === "1";
    current = { ...current, [key]: on };
  }
  return current;
}
