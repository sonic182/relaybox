import { readFileSync } from 'node:fs';
import { Router } from 'express';
import type { ChatService } from '../chats';
import type { InstanceService } from '../instances';
import { resolveStoredMediaPath } from '../mediaAccess';
import type { SendService } from '../sends';
import { notFound } from './errors';
import { findMessagesResponse, readConvertToMp4, readKeyId, readUpdateMessage } from './inputs';
import { requireApiInstance } from './instances';

function readStoredMedia(name: string, path: string): Buffer | undefined {
  const file = resolveStoredMediaPath(name, path);
  return file ? readFileSync(file) : undefined;
}

/** Evolution-compatible chat routes, mounted under `/chat`. */
export function createChatRoutes(
  service: InstanceService,
  sends: SendService,
  chats: ChatService,
): Router {
  const router = Router();

  router.post('/getBase64FromMediaMessage/:instanceName', async (req, res) => {
    const { instanceName } = req.params;
    requireApiInstance(service, instanceName);
    readConvertToMp4(req.body);

    const found = await chats.findMessage(instanceName, readKeyId(req.body, 'message'));
    const buffer = found?.media && readStoredMedia(instanceName, found.media.path);
    if (!found?.media || !buffer) throw notFound('Message media not found');

    res.status(201).json({
      mediaType: found.messageType,
      fileName: found.media.path,
      mimetype: found.media.mimetype,
      base64: buffer.toString('base64'),
    });
  });

  router.post('/findMessages/:instanceName', async (req, res) => {
    const { instanceName } = req.params;
    const instance = requireApiInstance(service, instanceName);

    const found = await chats.findMessage(instanceName, readKeyId(req.body, 'where'));
    res.json(findMessagesResponse(instance.id, found));
  });

  router.post('/updateMessage/:instanceName', async (req, res) => {
    const { instanceName } = req.params;
    const instance = requireApiInstance(service, instanceName);

    const input = readUpdateMessage(req.body);
    const key = req.get('Idempotency-Key')?.trim() || undefined;
    const message = await sends.once(instance.id, key, () => service.editMessage(instanceName, input));

    res.status(200).json(message);
  });

  return router;
}
