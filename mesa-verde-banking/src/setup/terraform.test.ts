import { describe, expect, it } from 'vitest';
import { terraformCommands, terraformEnv } from '@/setup/terraform';

const RUN = {
  dir: '/app',
  statePath: '/state/terraform.tfstate',
  apiKey: 'test-only-key',
  apiUrl: 'http://host.docker.internal:8000',
};

describe('terraformCommands', () => {
  it('initialises with the state file as the backend path, then applies without prompts', () => {
    expect(terraformCommands(RUN)).toEqual([
      [
        '-chdir=/app',
        'init',
        '-input=false',
        '-reconfigure',
        '-backend-config=path=/state/terraform.tfstate',
      ],
      ['-chdir=/app', 'apply', '-input=false', '-auto-approve'],
    ]);
  });
});

describe('terraformEnv', () => {
  it("passes the key and URL as main.tf's variables, keeping the rest of the environment", () => {
    expect(terraformEnv(RUN, { NODE_ENV: 'test', PATH: '/usr/bin' })).toEqual({
      NODE_ENV: 'test',
      PATH: '/usr/bin',
      TF_IN_AUTOMATION: '1',
      TF_VAR_permit_api_key: 'test-only-key',
      TF_VAR_permit_api_url: 'http://host.docker.internal:8000',
    });
  });
});
