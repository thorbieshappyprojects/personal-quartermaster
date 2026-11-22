import { describe, expect, it } from 'vitest';
import { loadAuthConfig, loadConfig, normaliseTeamDomain } from './config';

describe('auth config', () => {
  it('refuses DEV_AUTH in production', () => {
    expect(() => loadAuthConfig({ NODE_ENV: 'production', DEV_AUTH: '1' })).toThrow(/refused/);
  });

  it('refuses to run without the access gate', () => {
    expect(() => loadAuthConfig({ NODE_ENV: 'production' })).toThrow(/CF_ACCESS_TEAM_DOMAIN/);
    expect(() => loadAuthConfig({})).toThrow(/CF_ACCESS_TEAM_DOMAIN/);
    expect(() => loadAuthConfig({ CF_ACCESS_TEAM_DOMAIN: 'team' })).toThrow();
  });

  it('allows DEV_AUTH outside production', () => {
    expect(loadAuthConfig({ DEV_AUTH: '1', DEV_AUTH_EMAIL: 'dev@example.test' })).toEqual({
      mode: 'dev',
      email: 'dev@example.test',
    });
  });

  it('accepts access config', () => {
    expect(loadAuthConfig({ NODE_ENV: 'production', CF_ACCESS_TEAM_DOMAIN: 'team', CF_ACCESS_AUD: 'aud' })).toEqual({
      mode: 'access',
      teamDomain: 'team.cloudflareaccess.com',
      audience: 'aud',
    });
  });

  it('normalises team domains', () => {
    expect(normaliseTeamDomain('https://team.cloudflareaccess.com/')).toBe('team.cloudflareaccess.com');
    expect(normaliseTeamDomain('team')).toBe('team.cloudflareaccess.com');
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({ DEV_AUTH: '1' })).toThrow(/DATABASE_URL/);
  });
});
