import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from '../testing';

describe('static web app', () => {
  let t: TestContext;
  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'pq-web-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>QM</title>');
    await writeFile(join(root, 'assets', 'a-123.js'), 'console.log(1)');
    t = await createTestApp(undefined, {}, { webDir: root });
  });
  afterAll(async () => t.close());

  it('serves the shell, assets and an SPA fallback, with security headers', async () => {
    const index = await t.app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-security-policy']).toContain("default-src 'self'");
    const asset = await t.app.inject({ method: 'GET', url: '/assets/a-123.js' });
    expect(asset.headers['cache-control']).toContain('immutable');
    const deep = await t.app.inject({ method: 'GET', url: '/items/123', headers: { accept: 'text/html' } });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('<title>QM</title>');
    const apiMiss = await t.app.inject({ method: 'GET', url: '/api/v1/nope', headers: { accept: 'text/html' } });
    expect(apiMiss.statusCode).toBe(404);
    expect(apiMiss.json()).toEqual({ error: 'not_found' });
  });
});
