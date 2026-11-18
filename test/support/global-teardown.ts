import { execFileSync, type ChildProcess } from 'node:child_process';
import { killTestServers } from './global-setup';

export default async function globalTeardown() {
  const procs: ChildProcess[] = (globalThis as any).__PROCS__ ?? [];
  for (const p of procs) p.kill('SIGTERM');
  killTestServers();
  if (!process.env.KEEP_TEST_DB) {
    try {
      execFileSync('docker', ['rm', '-f', 'predictsim-test-pg'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
}
