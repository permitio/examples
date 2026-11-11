import { Permit } from 'permitio';

export interface PermitSettings {
  /** The Permit environment's API key, used for both the REST API and the PDP. */
  token: string;
  /** Permit's REST API, where the setup script and the API routes read and write policy data. */
  apiUrl: string;
  /** The PDP that answers `permit.check()`. */
  pdp: string;
  /**
   * The SDK's own log level. It defaults to `silent`: the SDK would log every error answer,
   * including the 409s setup expects, and the routes and scripts report errors themselves.
   */
  logLevel: string;
}

/** Reads the Permit settings from the environment; fails with the fix when the key is missing. */
export function permitSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PermitSettings {
  const token = env['PERMIT_API_KEY'];
  if (token === undefined || token === '') {
    throw new Error(
      'PERMIT_API_KEY is not set. Copy .env.example to .env and set it to the API key of the ' +
        'Permit environment this example should use.',
    );
  }
  return {
    token,
    apiUrl: env['PERMIT_API_URL'] || 'https://api.permit.io',
    pdp: env['PERMIT_PDP_URL'] || 'http://localhost:7766',
    logLevel: env['PERMIT_LOG_LEVEL'] || 'silent',
  };
}

let client: Permit | undefined;

/** The Permit SDK client, created on first use: a missing key fails the request, not the build. */
export function permit(): Permit {
  if (client === undefined) {
    const { token, apiUrl, pdp, logLevel } = permitSettings();
    client = new Permit({ token, apiUrl, pdp, log: { level: logLevel } });
  }
  return client;
}
