import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import type { Logger } from 'pino';
import { apiErrorBody } from '../contracts/evolution';

import { ApiError, badRequest, mapApiError } from './error-core';
export { ApiError, badRequest, unauthorized, notFound, conflict } from './error-core';

/** Terminal 404 for the JSON router, so unsupported reference routes never render HTML. */
export function apiNotFound(req: Request, res: Response): void {
  res.status(404).json(apiErrorBody(404, 'Not Found', [`Cannot ${req.method.toUpperCase()} ${req.originalUrl}`]));
}

/**
 * `express.json()` rejects an unparseable or oversized body with its own status attached.
 * Without this they reach the fallback below and a malformed request reads as our fault.
 */
function fromBodyParser(err: unknown): ApiError | undefined {
  const parsed = err as { type?: string; status?: number } | null;
  if (parsed?.type === 'entity.parse.failed') return badRequest('Request body is not valid JSON');
  if (parsed?.type === 'entity.too.large') return new ApiError(413, 'Payload Too Large', 'Request body is too large');
  if (err instanceof multer.MulterError) {
    return err.code === 'LIMIT_FILE_SIZE'
      ? new ApiError(413, 'Payload Too Large', 'Uploaded file is too large')
      : badRequest('Invalid multipart upload');
  }

  return undefined;
}

export function createApiErrorHandler(logger: Logger) {
  return function apiErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
    if (res.headersSent) {
      next(err);
      return;
    }

    const invalidPath = err instanceof URIError && (err as URIError & { status?: number }).status === 400
      ? badRequest('Invalid request path')
      : undefined;
    const mapped = invalidPath ?? fromBodyParser(err) ?? mapApiError(err) ?? err;

    if (mapped instanceof ApiError) {
      res.status(mapped.status).json(apiErrorBody(mapped.status, mapped.error, mapped.detail));
      return;
    }

    // Unexpected failures must not leak internals (stack traces, driver messages, secrets).
    logger.error({ err, method: req.method, path: req.originalUrl }, 'unhandled API error');
    res.status(500).json(apiErrorBody(500, 'Internal Server Error', 'Internal Server Error'));
  };
}
