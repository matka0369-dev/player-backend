/**
 * Integration-test environment: a throwaway Postgres in Docker, the real
 * migrations and seed, and the two real servers (core-service built from this
 * repo, prediction-service built from its sibling repo) running against it.
 *
 * It never reads DATABASE_URL from the environment or .env — the connection
 * string below is hard-coded to a localhost container, so a test run cannot
 * reach the Supabase database no matter what the shell has exported.
 *
 * KEEP_TEST_DB=1 leaves the container running afterwards for poking at.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CONTAINER = 'predictsim-test-pg';
const DB_PORT = 55432;
const CORE_PORT = 3100;
const PRED_PORT = 8180;
export const TEST_DB_URL = `postgresql://postgres:test@localhost:${DB_PORT}/predictsim_test`;

const CORE_DIR = path.resolve(__dirname, '../..');
const PRED_DIR = path.resolve(CORE_DIR, '../predictsim-prediction-service');

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return execFileSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, probe: () => Promise<boolean> | boolean, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await probe()) return;
    } catch {
      /* not yet */
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Servers left behind by an earlier aborted run would answer on our ports. Only
 *  the two test ports are touched, never a dev server on the usual ones. */
export function killTestServers() {
  for (const port of [CORE_PORT, PRED_PORT]) {
    try {
      const pids = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').filter(Boolean);
      for (const pid of pids) process.kill(Number(pid), 'SIGTERM');
    } catch {
      /* nothing listening */
    }
  }
}

export default async function globalSetup() {
  killTestServers();
  const procs: ChildProcess[] = [];
  (globalThis as any).__PROCS__ = procs;
  try {
    await start(procs);
  } catch (e) {
    // Jest skips teardown when setup throws, so clean up here.
    for (const p of procs) p.kill('SIGTERM');
    throw e;
  }
}

async function start(procs: ChildProcess[]) {
  // --- Postgres -----------------------------------------------------------
  try {
    sh('docker', ['rm', '-f', CONTAINER]);
  } catch {
    /* none to remove */
  }
  sh('docker', [
    'run', '-d', '--name', CONTAINER,
    '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=predictsim_test',
    '-p', `${DB_PORT}:5432`, 'postgres:16',
  ]);
  // The official image starts a temporary server, restarts, then serves: wait
  // for the *second* "ready" line so migrations don't hit the throwaway one.
  await waitFor('postgres', () => {
    const logs = sh('sh', ['-c', `docker logs ${CONTAINER} 2>&1`]);
    return (logs.match(/ready to accept connections/g) ?? []).length >= 2;
  });

  // --- schema + seed ------------------------------------------------------
  const dbEnv = { DATABASE_URL: TEST_DB_URL };
  sh('npx', ['prisma', 'migrate', 'deploy'], { cwd: CORE_DIR, env: dbEnv });
  sh('npx', ['ts-node', 'prisma/seed.ts'], {
    cwd: CORE_DIR,
    env: { ...dbEnv, BOOTSTRAP_ADMIN_EMAIL: 'pa@test.local', BOOTSTRAP_ADMIN_PASSWORD: 'Test-pa-1234!' },
  });

  // --- servers ------------------------------------------------------------
  sh('npm', ['run', 'build'], { cwd: CORE_DIR });
  const predBin = path.join(os.tmpdir(), 'predictsim-test-prediction-server');
  sh('go', ['build', '-o', predBin, './cmd/server'], { cwd: PRED_DIR });

  const common = { DATABASE_URL: TEST_DB_URL, NODE_ENV: 'test' };
  const log = (name: string) => fs.openSync(path.join(os.tmpdir(), `predictsim-test-${name}.log`), 'w');

  const core = spawn('node', ['dist/main.js'], {
    cwd: CORE_DIR,
    env: { ...process.env, ...common, PORT: String(CORE_PORT) },
    stdio: ['ignore', log('core'), log('core')],
  });
  const pred = spawn(predBin, [], {
    cwd: PRED_DIR,
    env: {
      ...process.env, ...common, PORT: String(PRED_PORT),
      ROUND_GENERATOR_INTERVAL_SECONDS: '1', ROUND_GENERATOR_DAYS_AHEAD: '1',
    },
    stdio: ['ignore', log('prediction'), log('prediction')],
  });
  procs.push(core, pred);

  await waitFor('core-service', async () => (await fetch(`http://localhost:${CORE_PORT}/`)).ok);
  await waitFor('prediction-service', async () => (await fetch(`http://localhost:${PRED_PORT}/healthz`)).ok);

  process.env.TEST_CORE_URL = `http://localhost:${CORE_PORT}`;
  process.env.TEST_PRED_URL = `http://localhost:${PRED_PORT}`;
  process.env.TEST_DATABASE_URL = TEST_DB_URL;
  process.env.TEST_PA_EMAIL = 'pa@test.local';
  process.env.TEST_PA_PASSWORD = 'Test-pa-1234!';
}
