// Starts the app's dev server inside one copy and stops it, including the
// worker processes Next spawns, by killing the whole process group.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export interface DevServer {
  url: string;
  /** Set when the server exited or never answered; the last lines of its output explain why. */
  failed: string | null;
  stop(): Promise<void>;
}

// Ports already handed out by this process. Two servers start at once, and the OS
// can offer the same just-closed port to both.
const handedOut = new Set<number>();

export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.unref();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    if (!handedOut.has(port)) {
      handedOut.add(port);
      return port;
    }
  }
}

export async function startDevServer(dir: string, command: string[], readyTimeoutMs: number): Promise<DevServer> {
  const port = await freePort();
  // Replaced by the address the server prints, so a server that moved to another
  // port is never confused with whatever else is listening on this one.
  let url = `http://127.0.0.1:${port}`;
  const [cmd, ...args] = command.map((p) => p.replaceAll('{port}', String(port)));
  const log: string[] = [];
  const spawnedAt = Date.now();
  const child: ChildProcess = spawn(cmd, args, {
    cwd: dir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), BROWSER: 'none', NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development' },
  });
  const keep = (b: Buffer) => {
    log.push(...b.toString().split('\n'));
    if (log.length > 200) log.splice(0, log.length - 200);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  let exited = false;
  child.on('exit', () => (exited = true));
  child.on('error', (e) => {
    exited = true;
    log.push(String(e));
  });

  const stop = async () => {
    if (exited || !child.pid) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
    const deadline = Date.now() + 5000;
    while (!exited && Date.now() < deadline) await sleep(100);
    if (!exited) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
  };

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (exited) return { url, failed: tail(log, 'exited before it was ready'), stop };
    // Next and Vite print "Local: <url>". Servers that never do get the assigned port after 15s.
    const printed = log.map((l) => /Local:\s+(https?:\/\/[^\s/]+)/.exec(l)?.[1]).find(Boolean);
    if (!printed && Date.now() - spawnedAt < 15_000) {
      await sleep(200);
      continue;
    }
    if (printed) url = printed.replace('localhost', '127.0.0.1');
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
      return { url, failed: null, stop };
    } catch {
      await sleep(300);
    }
  }
  await stop();
  return { url, failed: tail(log, `did not answer within ${Math.round(readyTimeoutMs / 1000)}s`), stop };
}

function tail(log: string[], why: string): string {
  const last = log.filter((l) => l.trim()).slice(-15).join('\n');
  return `Dev server ${why}.${last ? `\n${last}` : ''}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
