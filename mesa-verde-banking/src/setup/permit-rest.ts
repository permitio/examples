import { z } from 'zod';

/** One call to the Permit API, as a method, a path under the API URL, and an optional body. */
export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  path: string;
  body?: unknown;
  /** Statuses that count as done besides 2xx, such as 409 for "already exists". */
  accept?: readonly number[];
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

const REQUEST_TIMEOUT_MS = 30_000;
const ERROR_BODY_LIMIT = 500;

/** The URL and fetch options of a request. The API key goes only in the Authorization header. */
export function buildRequest(
  apiUrl: string,
  apiKey: string,
  request: ApiRequest,
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
  if (request.body !== undefined) headers['Content-Type'] = 'application/json';
  return {
    url: `${apiUrl}${request.path}`,
    init: {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  };
}

function parseBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** A small Permit API client for setup: the calls the SDK has no method for, and the seed. */
export class PermitRestClient {
  readonly #apiUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(apiUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.#apiUrl = apiUrl;
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
  }

  async send(request: ApiRequest): Promise<ApiResponse> {
    const { url, init } = buildRequest(this.#apiUrl, this.#apiKey, request);
    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${request.method} ${request.path} did not reach ${this.#apiUrl}: ${reason}. ` +
          'Check PERMIT_API_URL.',
        { cause: error },
      );
    }
    const text = await response.text();
    if (!response.ok && !(request.accept ?? []).includes(response.status)) {
      throw new Error(
        `${request.method} ${request.path} failed with HTTP ${response.status}: ` +
          text.slice(0, ERROR_BODY_LIMIT),
      );
    }
    return { status: response.status, body: parseBody(text) };
  }

  /** Sends requests one after another, in order. */
  async sendAll(requests: readonly ApiRequest[]): Promise<void> {
    for (const request of requests) {
      await this.send(request);
    }
  }
}

const apiKeyScope = z.object({
  project_id: z.string().nullish(),
  environment_id: z.string().nullish(),
});

export interface EnvironmentScope {
  project: string;
  environment: string;
}

/** The project and environment the API key belongs to; fails for a project or org key. */
export async function environmentScope(client: PermitRestClient): Promise<EnvironmentScope> {
  const { body } = await client.send({ method: 'GET', path: '/v2/api-key/scope' });
  const scope = apiKeyScope.parse(body);
  if (
    scope.project_id === undefined ||
    scope.project_id === null ||
    scope.environment_id === undefined ||
    scope.environment_id === null
  ) {
    throw new Error(
      'PERMIT_API_KEY is not an environment-level key. Copy the key of the environment to set ' +
        'up from Settings > API Keys in Permit.',
    );
  }
  return { project: scope.project_id, environment: scope.environment_id };
}
