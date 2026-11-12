import { describe, expect, it } from 'vitest';
import { chooseClassifier } from '#src/choose-classifier';
import { loadAppConfig, loadSetupConfig } from '#src/config';

const KEY = 'test-api-key-not-a-secret';

describe('loadAppConfig', () => {
  it('uses the defaults when only the API key is set', () => {
    expect(loadAppConfig({ PERMIT_API_KEY: KEY })).toEqual({
      port: 3000,
      apiKey: KEY,
      pdpUrl: 'http://localhost:7766',
      arcjetKey: undefined,
    });
  });

  it('reads every setting', () => {
    const config = loadAppConfig({
      PERMIT_API_KEY: KEY,
      PERMIT_PDP_URL: 'http://pdp:7000',
      PORT: '3104',
      ARCJET_KEY: 'ajkey_example',
    });
    expect(config).toEqual({
      port: 3104,
      apiKey: KEY,
      pdpUrl: 'http://pdp:7000',
      arcjetKey: 'ajkey_example',
    });
  });

  it('treats an empty ARCJET_KEY as unset, as Compose passes it', () => {
    expect(loadAppConfig({ PERMIT_API_KEY: KEY, ARCJET_KEY: '' }).arcjetKey).toBeUndefined();
  });

  it.each([undefined, '', '  '])('fails without PERMIT_API_KEY (%j)', (value) => {
    const env = value === undefined ? {} : { PERMIT_API_KEY: value };
    expect(() => loadAppConfig(env)).toThrow(/^Missing PERMIT_API_KEY: set PERMIT_API_KEY/);
  });

  it.each(['0', '65536', '30a', '-1'])('rejects PORT=%s', (port) => {
    expect(() => loadAppConfig({ PERMIT_API_KEY: KEY, PORT: port })).toThrow(/^Invalid PORT/);
  });

  it.each(['localhost:7766', 'ftp://pdp:7000', 'not a url'])('rejects PERMIT_PDP_URL=%s', (url) => {
    const run = () => loadAppConfig({ PERMIT_API_KEY: KEY, PERMIT_PDP_URL: url });
    expect(run).toThrow(
      'Invalid PERMIT_PDP_URL: expected an http(s) URL such as http://localhost:7766',
    );
  });
});

describe('loadSetupConfig', () => {
  it("defaults to Permit's cloud API", () => {
    expect(loadSetupConfig({ PERMIT_API_KEY: KEY })).toEqual({
      apiKey: KEY,
      apiUrl: 'https://api.permit.io',
      pdpUrl: 'http://localhost:7766',
    });
  });

  it('reads the PDP it waits for', () => {
    const env = { PERMIT_API_KEY: KEY, PERMIT_PDP_URL: 'http://pdp:7000' };
    expect(loadSetupConfig(env).pdpUrl).toBe('http://pdp:7000');
  });

  it('rejects a PERMIT_PDP_URL that is not a URL', () => {
    const env = { PERMIT_API_KEY: KEY, PERMIT_PDP_URL: 'localhost:7766' };
    expect(() => loadSetupConfig(env)).toThrow(/^Invalid PERMIT_PDP_URL/);
  });

  it('takes a local Permit backend', () => {
    const env = { PERMIT_API_KEY: KEY, PERMIT_API_URL: 'http://host.docker.internal:8000' };
    expect(loadSetupConfig(env).apiUrl).toBe('http://host.docker.internal:8000');
  });

  it('names the variable in an error, never its value', () => {
    const env = { PERMIT_API_KEY: KEY, PERMIT_API_URL: `${KEY} is not a URL` };
    expect(() => loadSetupConfig(env)).toThrow(/^Invalid PERMIT_API_URL/);
    expect(() => loadSetupConfig(env)).not.toThrow(KEY);
  });
});

describe('chooseClassifier', () => {
  it('uses the User-Agent check without an Arcjet key', () => {
    const classifier = chooseClassifier(undefined);
    expect(classifier.name).toBe('user-agent');
    expect(classifier.description).toBe('User-Agent check (ARCJET_KEY is not set)');
  });

  it('uses Arcjet with a key', () => {
    const classifier = chooseClassifier('ajkey_example');
    expect(classifier.name).toBe('arcjet');
    expect(classifier.description).toBe('Arcjet (ARCJET_KEY is set)');
  });
});
