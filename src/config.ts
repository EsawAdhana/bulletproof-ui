// Per-repo settings. Read from bulletproof.config.json at the repo root if the
// team commits one, else from the repo's private state dir (written by init).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Repo } from './repo.ts';

const Viewport = z.object({ name: z.string(), width: z.number(), height: z.number() });

export const Config = z.object({
  /** {port} is replaced with a free port. Run from the copy's root. */
  devCommand: z.array(z.string()).default(['node_modules/.bin/next', 'dev', '-p', '{port}', '-H', '127.0.0.1']),
  appDirs: z.array(z.string()).default(['src/app', 'app']),
  /** Where the app's own primitives live (Button, Input...). Auto-detected when empty. */
  componentsDir: z.string().default(''),
  /** Files allowed to define raw colors and sizes. */
  themeFiles: z.array(z.string()).default(['**/globals.css', 'tailwind.config.*', '**/theme.*']),
  uiExtensions: z.array(z.string()).default(['.tsx', '.jsx', '.css', '.scss']),
  uiExclude: z.array(z.string()).default(['**/*.test.*', '**/*.spec.*', 'e2e/**', 'tests/**', 'test/**', '**/__tests__/**']),
  /** Sample URL for each dynamic route, e.g. {"/[code]": "/CS106A"}. Dynamic routes without one are "not checked". */
  routes: z.record(z.string(), z.string()).default({}),
  /** Ignored top-level entries copied into the before/after copies (copy-on-write where the OS allows). */
  copyIgnored: z.array(z.string()).default(['node_modules', '.env*']),
  maxRoutes: z.number().default(6),
  viewports: z.array(Viewport).default([
    { name: 'phone', width: 390, height: 844 },
    { name: 'desktop', width: 1280, height: 800 },
  ]),
  schemes: z.array(z.enum(['light', 'dark'])).default(['light', 'dark']),
  /** CSS selectors for live data that changes between loads; painted over in both shots. */
  mask: z.array(z.string()).default([]),
  fixedTime: z.string().default('2026-11-05T17:00:00-08:00'),
  maxShotHeight: z.number().default(4000),
  maxRounds: z.number().default(3),
  /** Whole check, start to decision. Anything not reached in time is listed as not checked. */
  timeoutMs: z.number().default(5 * 60_000),
  devReadyTimeoutMs: z.number().default(120_000),
  judge: z
    .object({
      enabled: z.boolean().default(true),
      /** Command plus leading args; Bulletproof appends its own flags. Tests swap in a fake. */
      command: z.array(z.string()).default(['claude']),
      model: z.string().default('sonnet'),
      timeoutMs: z.number().default(180_000),
    })
    .prefault({}),
});
export type Config = z.infer<typeof Config>;

export function configPaths(repo: Repo): string[] {
  return [join(repo.root, 'bulletproof.config.json'), join(repo.stateDir, 'config.json')];
}

export function loadConfig(repo: Repo, overrides: Partial<Config> = {}): Config {
  const file = configPaths(repo).find((p) => existsSync(p));
  const raw = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const cfg = Config.parse({ ...raw, ...overrides });
  if (!cfg.componentsDir) {
    cfg.componentsDir = ['src/components/ui', 'components/ui', 'src/ui'].find((d) => existsSync(join(repo.root, d))) ?? '';
  }
  return cfg;
}
