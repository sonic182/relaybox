import { Router } from 'express';
import multer from 'multer';
import { MAX_OUTBOUND_MEDIA_BYTES } from '../config';
import type { InstanceService } from '../instances';
import type { SendService } from '../sends';
import { readSendAudio, readSendMedia, readSendText, sendOptions } from './inputs';
import { requireApiInstance } from './instances';

/** The reference accepts an uploaded `file` beside the JSON forms; memory keeps the send path uniform. */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_OUTBOUND_MEDIA_BYTES, files: 1 } });

/** Evolution-compatible message sending, mounted under `/message`. */
export function createMessageRoutes(service: InstanceService, sends: SendService): Router {
  const router = Router();

  router.post('/sendText/:instanceName', async (req, res) => {
    const { instanceName } = req.params;
    const instance = requireApiInstance(service, instanceName);

    const input = readSendText(req.body);
    // Optional: a caller that does not send the header has not asked for the guarantee.
    const key = req.get('Idempotency-Key')?.trim() || undefined;
    const message = await sends.once(instance.id, key, () =>
      service.sendText(instanceName, input.number, input.text, { ...sendOptions(input), linkPreview: input.linkPreview }),
    );

    // 201, as the reference answers, and carrying the key a caller correlates on.
    res.status(201).json(message);
  });

  router.post('/sendMedia/:instanceName', async (req, res) => {
    const { instanceName } = req.params;
    const instance = requireApiInstance(service, instanceName);

    const input = readSendMedia(req.body);
    const key = req.get('Idempotency-Key')?.trim() || undefined;
    const message = await sends.once(instance.id, key, () =>
      service.sendMedia(instanceName, input.number, input.mediatype, input.media, input.mimetype, {
        ...sendOptions(input),
        caption: input.caption,
        fileName: input.fileName,
      }),
    );

    res.status(201).json(message);
  });

  // Scoped like the body parsers in router.ts: chaining it on the route itself loses Express's
  // parameter typing, and this is the only group that accepts an upload.
  router.use('/sendWhatsAppAudio', upload.single('file'));

  router.post('/sendWhatsAppAudio/:instanceName', async (req, res) => {
    const { instanceName } = req.params;
    const instance = requireApiInstance(service, instanceName);

    const input = readSendAudio(req.body, req.file, Boolean(req.is('multipart/form-data')));
    const key = req.get('Idempotency-Key')?.trim() || undefined;
    const message = await sends.once(instance.id, key, () =>
      service.sendAudio(instanceName, input.number, input.audio, {
        ...sendOptions(input),
        encoding: input.encoding,
      }),
    );

    res.status(201).json(message);
  });

  return router;
}
