import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_EMAIL_HEADER } from '../auth';
import { createTestApp, type TestContext } from '../testing';

describe('members and persons (G1)', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  const asMember = { [DEV_EMAIL_HEADER]: 'member@example.test' };

  it('returns the caller and household', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ member: { role: 'owner' }, household: { base_currency: 'EUR' }, via: 'dev' });
  });

  it('lets the owner add a member, which also creates a person', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      payload: { email: 'Member@Example.test', display_name: 'Member' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: 'member@example.test', role: 'member' });
    const persons = (await t.app.inject({ method: 'GET', url: '/api/v1/persons' })).json();
    expect(persons.filter((p: { kind: string }) => p.kind === 'member')).toHaveLength(2);
  });

  it('rejects duplicates and invalid input', async () => {
    const dup = await t.app.inject({ method: 'POST', url: '/api/v1/members', payload: { email: 'member@example.test', display_name: 'X' } });
    expect(dup.statusCode).toBe(409);
    const bad = await t.app.inject({ method: 'POST', url: '/api/v1/members', payload: { email: 'nope', display_name: 'X' } });
    expect(bad.statusCode).toBe(400);
  });

  it('does not let a member add members or change roles', async () => {
    const add = await t.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: asMember,
      payload: { email: 'x@example.test', display_name: 'X' },
    });
    expect(add.statusCode).toBe(403);
    const me = (await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: asMember })).json().member;
    const promote = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${me.id}`,
      headers: asMember,
      payload: { role: 'owner' },
    });
    expect(promote.statusCode).toBe(403);
    const rename = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${me.id}`,
      headers: asMember,
      payload: { display_name: 'Renamed' },
    });
    expect(rename.statusCode).toBe(200);
    const other = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${t.ownerId}`,
      headers: asMember,
      payload: { display_name: 'Hijack' },
    });
    expect(other.statusCode).toBe(403);
  });

  it('keeps at least one owner', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: `/api/v1/members/${t.ownerId}`, payload: { role: 'member' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('last_owner');
  });

  it('manages dependants without a login', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/v1/persons', payload: { display_name: 'Pet' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ kind: 'dependant', member_id: null });
    const renamed = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/persons/${created.json().id}`,
      payload: { display_name: 'Dog' },
    });
    expect(renamed.json().display_name).toBe('Dog');
    const missing = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/persons/00000000-0000-4000-8000-000000000000',
      payload: { display_name: 'X' },
    });
    expect(missing.statusCode).toBe(404);
  });
});
