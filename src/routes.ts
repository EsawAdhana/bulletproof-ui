// Which pages render the changed files: follow imports backwards from each
// changed file until reaching a Next.js app-router page or layout.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { parseSync } from 'oxc-parser';
import { ResolverFactory } from 'oxc-resolver';
import type { Config } from './config.ts';

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.css', '.scss']);
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out', 'coverage', '.turbo', '.vercel']);
const PAGE = /^page\.(tsx|jsx|ts|js)$/;
/** Files that wrap every page below their folder. */
const WRAPPER = /^(layout|template|loading|error|not-found)\.(tsx|jsx|ts|js)$/;
/** Changing these restyles the whole app. */
const GLOBAL = [/^tailwind\.config\./, /^postcss\.config\./];

export interface Route {
  /** Route as written in the file tree, e.g. /instructors/[slug] */
  pattern: string;
  /** URL path that is actually visited. */
  url: string;
  /** Import steps from the nearest changed file; 0 = the page itself changed. */
  distance: number;
}

export interface RouteResult {
  routes: Route[];
  notChecked: string[];
}

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(root, join(dir, e.name), out);
    } else if (SOURCE_EXT.has(extname(e.name))) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  if (/\.s?css$/.test(file)) {
    return [...src.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)].map((m) => m[1]);
  }
  try {
    const { module } = parseSync(file, src);
    const reqs = module.staticImports.map((i) => i.moduleRequest.value);
    for (const e of module.staticExports) for (const en of e.entries) if (en.moduleRequest) reqs.push(en.moduleRequest.value);
    for (const d of module.dynamicImports) {
      const lit = src.slice(d.moduleRequest.start, d.moduleRequest.end);
      const m = /^['"`]([^'"`$]+)['"`]$/.exec(lit);
      if (m) reqs.push(m[1]);
    }
    return reqs;
  } catch {
    return [];
  }
}

export function routePattern(appDir: string, pageFile: string): string {
  const segs = relative(appDir, dirname(pageFile))
    .split(sep)
    .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'));
  return '/' + segs.join('/');
}

export function affectedRoutes(rootIn: string, changedRel: string[], cfg: Config): RouteResult {
  // The resolver returns real paths (macOS temp dirs live behind the /var -> /private/var link).
  const root = realpathSync(rootIn);
  const appDir = cfg.appDirs.map((d) => join(root, d)).find((d) => existsSync(d));
  if (!appDir) return { routes: [], notChecked: ['No Next.js app directory found, so no pages were checked.'] };

  const files = walk(root);
  const tsconfig = join(root, 'tsconfig.json');
  const resolver = new ResolverFactory({
    tsconfig: existsSync(tsconfig) ? { configFile: tsconfig, references: 'auto' } : undefined,
    extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json', '.css', '.scss'],
    conditionNames: ['import', 'default'],
  });

  const importers = new Map<string, Set<string>>();
  for (const f of files) {
    for (const req of importsOf(f)) {
      const r = resolver.sync(dirname(f), req);
      const target = r.path;
      if (!target || !target.startsWith(root + sep) || target.includes(`${sep}node_modules${sep}`)) continue;
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target)!.add(f);
    }
  }

  const pages = files.filter((f) => f.startsWith(appDir + sep) && PAGE.test(basename(f)));
  const changed = changedRel.map((f) => join(root, f));
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const c of changed) {
    dist.set(c, 0);
    queue.push(c);
  }
  while (queue.length) {
    const f = queue.shift()!;
    for (const imp of importers.get(f) ?? []) {
      if (!dist.has(imp)) {
        dist.set(imp, dist.get(f)! + 1);
        queue.push(imp);
      }
    }
  }

  const reached = new Map<string, number>(); // page -> distance
  const reach = (page: string, d: number) => reached.set(page, Math.min(d, reached.get(page) ?? Infinity));
  const global = changedRel.some((f) => GLOBAL.some((g) => g.test(basename(f))));
  for (const page of pages) {
    if (global) reach(page, 1);
    if (dist.has(page)) reach(page, dist.get(page)!);
  }
  // A layout (or a file it imports) reaches every page under the layout's folder.
  for (const [file, d] of dist) {
    if (file.startsWith(appDir + sep) && WRAPPER.test(basename(file))) {
      for (const page of pages) if (page.startsWith(dirname(file) + sep)) reach(page, d + 1);
    }
  }

  const notChecked: string[] = [];
  const candidates: Route[] = [];
  for (const [page, distance] of [...reached].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))) {
    const pattern = routePattern(appDir, page);
    if (pattern.includes('[')) {
      const url = cfg.routes[pattern];
      if (!url) {
        notChecked.push(`${pattern}: dynamic route with no sample URL (add one under "routes" in the config).`);
        continue;
      }
      candidates.push({ pattern, url, distance });
    } else {
      candidates.push({ pattern, url: pattern, distance });
    }
  }
  const routes = candidates.slice(0, cfg.maxRoutes);
  for (const r of candidates.slice(cfg.maxRoutes)) notChecked.push(`${r.pattern}: over the limit of ${cfg.maxRoutes} pages per check.`);

  if (!reached.size && changedRel.length) {
    notChecked.push(`No page renders ${changedRel.join(', ')}, so there was nothing to screenshot.`);
  }
  return { routes, notChecked };
}
