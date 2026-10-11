import { apiErrorBody } from '../contracts/evolution';
import { InstanceAlreadyExistsError, InstanceNameTakenError, InstanceNotConnectedError } from '../instances';
import { InvalidMediaError } from '../mediaFetch';
import { SendInProgressError } from '../sends';
import { InstanceNotFoundError, WebhookValidationError } from '../webhooks';

/** Errors whose details are safe to return to API clients. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly error: string, readonly detail: string | string[]) {
    super(Array.isArray(detail) ? detail.join(', ') : detail);
    this.name = 'ApiError';
  }
}

export const badRequest = (detail: string | string[]) => new ApiError(400, 'Bad Request', detail);
export const unauthorized = (detail: string | string[] = 'Unauthorized') => new ApiError(401, 'Unauthorized', detail);
export const notFound = (detail: string | string[]) => new ApiError(404, 'Not Found', detail);
export const conflict = (detail: string | string[]) => new ApiError(409, 'Conflict', detail);

export function mapApiError(err: unknown): ApiError | undefined {
  if (err instanceof ApiError) return err;
  if (err instanceof WebhookValidationError) return badRequest(err.messages);
  if (err instanceof InstanceNotFoundError) return notFound(err.message);
  if (err instanceof InstanceAlreadyExistsError) return conflict(err.message);
  if (err instanceof InstanceNameTakenError) return conflict(err.message);
  if (err instanceof InstanceNotConnectedError) return badRequest(err.message);
  if (err instanceof InvalidMediaError) return badRequest(err.message);
  if (err instanceof SendInProgressError) return conflict(err.message);
  return undefined;
}

export function apiErrorResponse(err: ApiError) {
  return { status: err.status, body: apiErrorBody(err.status, err.error, err.detail) };
}
