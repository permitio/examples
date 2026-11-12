import { describe, expect, it } from 'vitest';
import {
  appUrl,
  authSecretPath,
  databasePath,
  elementsSettings,
  permitSettings,
  publicUrl,
  webhookSecret,
} from '@/lib/env';

describe('permitSettings', () => {
  it('requires the API key and says where to set it', () => {
    expect(() => permitSettings({})).toThrow('PERMIT_API_KEY is not set');
    expect(() => permitSettings({ PERMIT_API_KEY: '  ' })).toThrow('PERMIT_API_KEY is not set');
  });

  it('defaults to Permit SaaS and a local PDP, and drops trailing slashes', () => {
    expect(permitSettings({ PERMIT_API_KEY: 'k' })).toEqual({
      apiKey: 'k',
      apiUrl: 'https://api.permit.io',
      pdpUrl: 'http://localhost:7766',
    });
    expect(
      permitSettings({
        PERMIT_API_KEY: 'k',
        PERMIT_API_URL: 'http://host.docker.internal:8000/',
        PERMIT_PDP_URL: 'http://pdp:7000/',
      }),
    ).toEqual({
      apiKey: 'k',
      apiUrl: 'http://host.docker.internal:8000',
      pdpUrl: 'http://pdp:7000',
    });
  });
});

describe('file and URL settings', () => {
  it('keeps the generated auth secret next to the database', () => {
    expect(databasePath({})).toBe('data/mesa-verde.db');
    expect(authSecretPath({ DATABASE_PATH: '/data/mesa-verde.db' })).toBe('/data/auth-secret');
  });

  it('treats an unset or blank PUBLIC_URL and WEBHOOK_SECRET as off', () => {
    expect(publicUrl({ PUBLIC_URL: ' ' })).toBeUndefined();
    expect(webhookSecret({})).toBeUndefined();
    expect(publicUrl({ PUBLIC_URL: 'https://bank.example/' })).toBe('https://bank.example');
    expect(appUrl({})).toBe('http://localhost:3000');
  });
});

describe('elementsSettings', () => {
  it('defaults to Permit SaaS', () => {
    expect(elementsSettings({})).toEqual({
      embedUrl: 'https://embed.permit.io',
      apiUrl: 'https://api.permit.io',
    });
  });

  it('uses the browser-facing API URL when the server reaches Permit at another one', () => {
    expect(
      elementsSettings({
        PERMIT_API_URL: 'http://host.docker.internal:8000',
        PERMIT_ELEMENTS_API_URL: 'http://localhost:8000',
        PERMIT_ELEMENTS_URL: 'http://localhost:3000/embed/',
      }),
    ).toEqual({ embedUrl: 'http://localhost:3000/embed', apiUrl: 'http://localhost:8000' });
    expect(elementsSettings({ PERMIT_API_URL: 'https://api.eu.example' }).apiUrl).toBe(
      'https://api.eu.example',
    );
  });
});
