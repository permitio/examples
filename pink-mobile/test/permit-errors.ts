import { PermitApiError, PermitConnectionError } from 'permitio';

type AxiosErrorLike = ConstructorParameters<typeof PermitApiError>[1];

/** The error the SDK throws when Permit's REST API answers `status`. */
export function apiError(status: number, data: unknown = { message: 'from Permit' }) {
  const message = `Request failed with status code ${status}`;
  const original = { message, response: { status, data } };
  return new PermitApiError(message, original as unknown as AxiosErrorLike);
}

/** The error the SDK throws when the PDP does not answer. */
export const pdpDown = () => new PermitConnectionError('connect ECONNREFUSED 127.0.0.1:7766');
