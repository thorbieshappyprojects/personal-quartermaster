import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from '../testing';

describe('GET /healthz', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  it('answers ok when db and media are fine', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('answers 503 when the media volume has 10 % or less free', async () => {
    const low = await createTestApp(undefined, { diskStats: async () => ({ blocks: 100, bavail: 10 }) });
    try {
      const res = await low.app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ ok: false });
    } finally {
      await low.close();
    }
  });

  it('answers 503 without details when media is not writable', async () => {
    await rm(t.mediaDir, { recursive: true, force: true });
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false });
  });
});
