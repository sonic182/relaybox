import type { Request, Response } from 'express';
import type { ChatService } from '../chats';
import { isValidName } from '../instances';
import { resolveStoredMediaPath, verifyMediaSignature } from '../mediaAccess';
import { sendStoredMedia } from './mediaResponse';

/**
 * Serves stored media behind a short-lived HMAC token instead of the dashboard cookie, so an
 * MCP tool can hand out a URL the caller fetches directly without exposing the API key.
 */
export function createMediaController(service: ChatService) {
  async function byToken(req: Request, res: Response): Promise<void> {
    const { instanceName } = req.params;
    const keyId = typeof req.params.keyId === 'string' ? req.params.keyId : undefined;
    const exp = typeof req.query.exp === 'string' ? req.query.exp : undefined;
    const sig = typeof req.query.sig === 'string' ? req.query.sig : undefined;

    if (!isValidName(instanceName) || !keyId || !verifyMediaSignature(instanceName, keyId, exp, sig)) {
      res.status(403).send('Invalid or expired media token');
      return;
    }

    const found = await service.getMedia(instanceName, keyId);
    const file = found ? resolveStoredMediaPath(instanceName, found.path) : undefined;
    if (!found || !file) {
      res.status(404).send('Not found');
      return;
    }

    sendStoredMedia(res, file, found);
  }

  return { byToken };
}
