import { describe, expect, it } from 'vitest';
import { Config } from '../src/config.ts';
import { affectedRoutes } from '../src/routes.ts';
import { makeRepo } from './helpers.ts';

const app = makeRepo({
  'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
  'app/layout.tsx': "import './globals.css';\nimport { Nav } from '@/components/nav';\nexport default function L() {}\n",
  'app/globals.css': 'body {}\n',
  'app/page.tsx': "import { Card } from '@/components/card';\nexport default function P() {}\n",
  'app/(marketing)/about/page.tsx': 'export default function P() {}\n',
  'app/courses/[code]/page.tsx': "import { Card } from '../../../components/card';\nexport default function P() {}\n",
  'app/settings/layout.tsx': "import { Tabs } from '@/components/tabs';\nexport default function L() {}\n",
  'app/settings/page.tsx': 'export default function P() {}\n',
  'app/settings/profile/page.tsx': 'export default function P() {}\n',
  'components/card.tsx': "export { Badge } from './badge';\nexport function Card() {}\n",
  'components/badge.tsx': "const Lazy = () => import('./sparkle');\nexport function Badge() {}\n",
  'components/sparkle.tsx': 'export default function S() {}\n',
  'components/nav.tsx': 'export function Nav() {}\n',
  'components/tabs.tsx': 'export function Tabs() {}\n',
  'components/unused.tsx': 'export function U() {}\n',
  'tailwind.config.ts': 'export default {}\n',
});

const cfg = (extra: Partial<Config> = {}) => Config.parse({ routes: { '/courses/[code]': '/courses/CS106A' }, ...extra });
const urls = (files: string[], c = cfg()) => affectedRoutes(app, files, c).routes.map((r) => r.url);

describe('affectedRoutes', () => {
  it('follows imports, re-exports and dynamic imports back to pages', () => {
    expect(urls(['components/sparkle.tsx']).sort()).toEqual(['/', '/courses/CS106A']);
  });

  it('puts the closest page first', () => {
    const r = affectedRoutes(app, ['app/page.tsx', 'components/card.tsx'], cfg()).routes;
    expect(r[0]).toMatchObject({ url: '/', distance: 0 });
  });

  it('sends a layout change to every page under it', () => {
    expect(urls(['components/tabs.tsx']).sort()).toEqual(['/settings', '/settings/profile']);
    expect(urls(['app/globals.css'])).toHaveLength(5);
  });

  it('drops route groups from the URL', () => {
    expect(urls(['app/(marketing)/about/page.tsx'])).toEqual(['/about']);
  });

  it('treats the Tailwind config as touching every page', () => {
    expect(urls(['tailwind.config.ts'])).toHaveLength(5);
  });

  it('lists a dynamic route with no sample URL as not checked', () => {
    const r = affectedRoutes(app, ['components/card.tsx'], Config.parse({}));
    expect(r.routes.map((x) => x.url)).toEqual(['/']);
    expect(r.notChecked.join('\n')).toContain('/courses/[code]');
  });

  it('lists pages over the limit as not checked instead of dropping them', () => {
    const r = affectedRoutes(app, ['app/globals.css'], cfg({ maxRoutes: 2 }));
    expect(r.routes).toHaveLength(2);
    expect(r.notChecked.filter((n) => n.includes('over the limit'))).toHaveLength(3);
  });

  it('says so when no page renders the changed file', () => {
    const r = affectedRoutes(app, ['components/unused.tsx'], cfg());
    expect(r.routes).toEqual([]);
    expect(r.notChecked[0]).toContain('No page renders components/unused.tsx');
  });
});
