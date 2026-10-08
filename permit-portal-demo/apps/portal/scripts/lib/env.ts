export interface ScriptEnv { profile: string; apiUrl: string; apiKey: string; pdpUrl: string; greatEagleSystemsUrl: string; portalUrl: string }

const REQUIRED = ['PERMIT_API_URL', 'PERMIT_API_KEY', 'PROFILE'] as const;

/** A required setting is missing, so the script could not run (exit 2). The message names variables, never values. */
export class MissingEnvError extends Error {
  constructor(readonly missing: readonly string[]) {
    const names = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`;
    super(`Missing ${names}: run the script through bin/demo <command> <profile>, which loads profiles/<profile>.env (see profiles/README.md)`);
    this.name = 'MissingEnvError';
  }
}

/** The scripts' settings. bin/demo loads PERMIT_API_URL and PERMIT_API_KEY from the profile and sets PROFILE. */
export function scriptEnv(env: NodeJS.ProcessEnv = process.env): ScriptEnv {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) throw new MissingEnvError(missing);
  return {
    profile: env.PROFILE as string,
    apiUrl: env.PERMIT_API_URL as string,
    apiKey: env.PERMIT_API_KEY as string,
    pdpUrl: env.PERMIT_PDP_URL || 'http://localhost:7766',
    greatEagleSystemsUrl: env.GREAT_EAGLE_SYSTEMS_URL || 'http://localhost:4100',
    portalUrl: env.PORTAL_URL || 'http://localhost:3000',
  };
}
