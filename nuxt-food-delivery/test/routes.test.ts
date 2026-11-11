import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '#test/server';

const ROUTES_DIR = join(import.meta.dirname, '..', 'server', 'routes');

/** The method and path Nitro mounts a server/routes/ file at. */
function mountOf(file: string) {
  const match = /^(?<path>.+?)(?:\.(?<method>get|post|delete))?\.ts$/.exec(file);
  if (match?.groups === undefined) throw new Error(`Unexpected route file name: ${file}`);
  const path = `/${match.groups['path']}`.replace(/\/index$/, '').replace(/\[(\w+)\]/g, ':$1');
  return { method: match.groups['method'] ?? 'all', path };
}

describe('the test server', () => {
  const files = readdirSync(ROUTES_DIR, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .sort();

  it('serves every file in server/routes/', () => {
    expect(ROUTES.map((route) => route.file).sort()).toEqual(files);
  });

  it.each(ROUTES.map((route) => [route.file, route] as const))(
    'mounts %s where Nitro does',
    (file, route) => {
      expect({ method: route.method, path: route.path }).toEqual(mountOf(file));
    },
  );
});
