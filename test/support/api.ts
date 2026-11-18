/** A tiny HTTP client with a cookie jar — one instance per signed-in account. */
export interface Reply<T = any> {
  status: number;
  data: T;
}

export class Api {
  cookie: string | null = null;
  id = '';
  username = '';

  constructor(readonly base: string) {}

  async raw<T = any>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      if (c.startsWith('predictsim_sid')) this.cookie = c.split(';')[0];
    }
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  }

  /** Happy path: throws with the server's message on any non-2xx. */
  async ok<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.raw<T>(method, path, body);
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    }
    return r.data;
  }

  /** The same signed-in account, talking to another service (sessions are shared). */
  at(base: string): Api {
    const other = new Api(base);
    other.cookie = this.cookie;
    other.id = this.id;
    other.username = this.username;
    return other;
  }

  async login(identifier: string, password: string): Promise<this> {
    const r = await this.ok('POST', '/auth/login', { identifier, password });
    this.id = r.user.id;
    this.username = r.user.username;
    return this;
  }
}

export const core = () => process.env.TEST_CORE_URL!;
export const pred = () => process.env.TEST_PRED_URL!;
export const PASSWORD = 'Test-1234!';

let n = 0;
/** Unique-per-run suffix so suites never collide on usernames/emails. */
export const uniq = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;
