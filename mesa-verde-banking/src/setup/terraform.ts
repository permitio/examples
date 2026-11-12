import { spawn } from 'node:child_process';

export interface TerraformRun {
  /** The folder that holds main.tf. */
  dir: string;
  /** The state file, absolute or relative to `dir`. */
  statePath: string;
  apiKey: string;
  apiUrl: string;
}

/**
 * `terraform init` with the state file as the local backend's path, then `terraform apply`. Without
 * a terminal (a container's log), the output has no color codes.
 */
export function terraformCommands({ dir, statePath }: TerraformRun, color: boolean): string[][] {
  const chdir = `-chdir=${dir}`;
  const colorFlags = color ? [] : ['-no-color'];
  return [
    [
      chdir,
      'init',
      '-input=false',
      ...colorFlags,
      '-reconfigure',
      `-backend-config=path=${statePath}`,
    ],
    [chdir, 'apply', '-input=false', ...colorFlags, '-auto-approve'],
  ];
}

/** Terraform's environment: the API key and URL as variables (main.tf marks the key sensitive). */
export function terraformEnv(
  { apiKey, apiUrl }: TerraformRun,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...base,
    TF_IN_AUTOMATION: '1',
    TF_VAR_permit_api_key: apiKey,
    TF_VAR_permit_api_url: apiUrl,
  };
}

function run(args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('terraform', args, { env, stdio: 'inherit' });
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new Error(
              'terraform is not installed. Install Terraform 1.5 or later, or run setup with ' +
                '`docker compose up`, whose setup image has it.',
            )
          : error,
      );
    });
    child.on('exit', (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`terraform ${args[1] ?? ''} exited with code ${String(code)}`));
    });
  });
}

/** Applies main.tf to the environment of the API key. */
export async function applySchema(terraform: TerraformRun, base: NodeJS.ProcessEnv): Promise<void> {
  const env = terraformEnv(terraform, base);
  for (const args of terraformCommands(terraform, process.stdout.isTTY)) {
    await run(args, env);
  }
}
