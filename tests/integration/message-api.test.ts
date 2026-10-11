import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import sendAudio from '../fixtures/evolution/send-audio.request.json';
import sendAudioResponse from '../fixtures/evolution/send-audio.response.json';
import sendMedia from '../fixtures/evolution/send-media.request.json';
import sendMediaResponse from '../fixtures/evolution/send-media.response.json';
import sendText from '../fixtures/evolution/send-text.request.json';
import sendTextResponse from '../fixtures/evolution/send-text.response.json';
import { MAX_OUTBOUND_MEDIA_BYTES } from '../../src/config';
import { InvalidMediaError } from '../../src/mediaFetch';
import { createSendTestApp } from '../helpers';

const API_KEY = 'test-api-key-0000';

async function expectMissingInstance(path: string, body: object) {
  const { app } = await createSendTestApp();
  const response = await request(app).post(path).set('apikey', API_KEY).send(body).expect(404);
  expect(response.body).toEqual({
    status: 404,
    error: 'Not Found',
    response: { message: 'The "ghost" instance does not exist' },
  });
}

describe('POST /message/sendText/:instanceName', () => {
  it('answers 201 with a key the caller can correlate on', async () => {
    const { instanceService, app } = await createSendTestApp();

    const response = await request(app)
      .post('/message/sendText/acme')
      .set('apikey', API_KEY)
      .send(sendText)
      .expect(201);

    // The consumer reads body.key.id and treats anything else as a failed send.
    expect(response.body).toEqual(sendTextResponse);
    expect(response.body.key).toMatchObject({ id: expect.any(String), fromMe: true });
    expect(response.body.key.id).not.toBe('');
    expect(response.body.key.remoteJid).toBe('5511888888888@s.whatsapp.net');
    expect(response.body.message).toEqual({ conversation: sendText.text });
    expect(instanceService.sendText).toHaveBeenCalledWith('acme', sendText.number, sendText.text, { delay: sendText.delay, presence: sendText.presence });
  });

  it.each([
    ['a missing number', { text: 'hola' }],
    ['a blank number', { number: '   ', text: 'hola' }],
    ['missing text', { number: '5511888888888' }],
    // Whitespace-only text would send an empty bubble.
    ['blank text', { number: '5511888888888', text: '   ' }],
    ['a number with no digits', { number: 'abc', text: 'hola' }],
    ['a jid with no local part', { number: '@', text: 'hola' }],
    ['a negative delay', { number: '5511888888888', text: 'hola', delay: -1 }],
    ['a fractional delay', { number: '5511888888888', text: 'hola', delay: 1.5 }],
    ['a delay over five minutes', { number: '5511888888888', text: 'hola', delay: 300_001 }],
    ['an unknown presence', { number: '5511888888888', text: 'hola', presence: 'dancing' }],
    ['a quote without its key ID', { number: '5511888888888', text: 'hola', quoted: { key: {} } }],
    ['non-array mentions', { number: '5511888888888', text: 'hola', mentioned: '5511888888888' }],
    ['a non-boolean everyone mention', { number: '5511888888888', text: 'hola', mentionsEveryOne: 'true' }],
    ['a non-boolean link preview', { number: '5511888888888', text: 'hola', linkPreview: 'false' }],
    ['no body at all', {}],
  ])('rejects %s', async (_label, body) => {
    const { instanceService, app } = await createSendTestApp();

    await request(app).post('/message/sendText/acme').set('apikey', API_KEY).send(body).expect(400);

    expect(instanceService.sendText).not.toHaveBeenCalled();
  });

  it('reports an instance that exists but is not connected', async () => {
    const { app } = await createSendTestApp('close');

    const response = await request(app)
      .post('/message/sendText/acme')
      .set('apikey', API_KEY)
      .send(sendText)
      .expect(400);

    expect(response.body.response.message).toBe('The "acme" instance is not connected');
  });

  it('forwards delay without a presence', async () => {
    const { instanceService, app } = await createSendTestApp();

    await request(app)
      .post('/message/sendText/acme')
      .set('apikey', API_KEY)
      .send({ number: '5511888888888', text: 'hola', delay: 1500 })
      .expect(201);

    expect(instanceService.sendText).toHaveBeenCalledWith('acme', '5511888888888', 'hola', { delay: 1500, presence: undefined });
  });

  it('answers 404 with the reference wording for an unknown instance', async () => {
    await expectMissingInstance('/message/sendText/ghost', sendText);
  });

  it('requires the api key', async () => {
    const { instanceService, app } = await createSendTestApp();

    await request(app).post('/message/sendText/acme').send(sendText).expect(401);

    expect(instanceService.sendText).not.toHaveBeenCalled();
  });

  describe('Idempotency-Key', () => {
    it('sends once for a repeated key and replays the same body', async () => {
      const { instanceService, app } = await createSendTestApp();

      const first = await request(app)
        .post('/message/sendText/acme')
        .set('apikey', API_KEY)
        .set('Idempotency-Key', 'order-42')
        .send(sendText)
        .expect(201);

      const replay = await request(app)
        .post('/message/sendText/acme')
        .set('apikey', API_KEY)
        .set('Idempotency-Key', 'order-42')
        .send(sendText)
        .expect(201);

      expect(instanceService.sendText).toHaveBeenCalledOnce();
      expect(replay.body).toEqual(first.body);
    });

    it('sends twice without the header, since the caller did not ask for the guarantee', async () => {
      const { instanceService, app } = await createSendTestApp();

      await request(app).post('/message/sendText/acme').set('apikey', API_KEY).send(sendText).expect(201);
      await request(app).post('/message/sendText/acme').set('apikey', API_KEY).send(sendText).expect(201);

      expect(instanceService.sendText).toHaveBeenCalledTimes(2);
    });

    it('ignores a blank key rather than treating it as one', async () => {
      const { instanceService, app } = await createSendTestApp();

      for (let attempt = 0; attempt < 2; attempt++) {
        await request(app)
          .post('/message/sendText/acme')
          .set('apikey', API_KEY)
          .set('Idempotency-Key', '   ')
          .send(sendText)
          .expect(201);
      }

      expect(instanceService.sendText).toHaveBeenCalledTimes(2);
    });
  });

  it('rejects a malformed json body without reaching the service', async () => {
    const { instanceService, app } = await createSendTestApp();

    await request(app)
      .post('/message/sendText/acme')
      .set('apikey', API_KEY)
      .set('content-type', 'application/json')
      .send('{')
      .expect(400);

    expect(instanceService.sendText).not.toHaveBeenCalled();
  });

  it('keeps unmounted message routes on the json error envelope', async () => {
    const { app } = await createSendTestApp();

    const response = await request(app).post('/message/sendSticker/acme').set('apikey', API_KEY).expect(404);

    expect(response.body.error).toBe('Not Found');
  });
});

describe('POST /message/sendMedia/:instanceName', () => {
  it('answers 201 with the normalized sent message', async () => {
    const { instanceService, app } = await createSendTestApp();

    const response = await request(app)
      .post('/message/sendMedia/acme')
      .set('apikey', API_KEY)
      .send(sendMedia)
      .expect(201);

    expect(response.body).toEqual(sendMediaResponse);
    expect(instanceService.sendMedia).toHaveBeenCalledWith(
      'acme',
      sendMedia.number,
      sendMedia.mediatype,
      sendMedia.media,
      sendMedia.mimetype,
      { caption: sendMedia.caption, fileName: undefined, delay: undefined, presence: undefined },
    );
  });

  it.each([
    ['a missing number', { ...sendMedia, number: undefined }],
    ['an unknown mediatype', { ...sendMedia, mediatype: 'sticker' }],
    ['a missing media payload', { ...sendMedia, media: undefined }],
    ['a non-string mimetype', { ...sendMedia, mimetype: 5 }],
    ['no body at all', {}],
  ])('rejects %s', async (_label, body) => {
    const { instanceService, app } = await createSendTestApp();

    await request(app).post('/message/sendMedia/acme').set('apikey', API_KEY).send(body).expect(400);

    expect(instanceService.sendMedia).not.toHaveBeenCalled();
  });

  it.each([['omitted', undefined], ['null', null], ['blank', '  ']])('leaves a %s mimetype for the service to infer', async (_label, mimetype) => {
    const { instanceService, app } = await createSendTestApp();

    await request(app)
      .post('/message/sendMedia/acme')
      .set('apikey', API_KEY)
      .send({ ...sendMedia, mimetype })
      .expect(201);

    expect(instanceService.sendMedia).toHaveBeenCalledWith('acme', sendMedia.number, sendMedia.mediatype, sendMedia.media, undefined, expect.anything());
  });

  it('sends audio as a file-style bubble, which sendWhatsAppAudio does not', async () => {
    const { instanceService, app } = await createSendTestApp();

    await request(app)
      .post('/message/sendMedia/acme')
      .set('apikey', API_KEY)
      .send({ number: sendMedia.number, mediatype: 'audio', media: sendMedia.media, mimetype: 'audio/ogg' })
      .expect(201);

    expect(instanceService.sendMedia).toHaveBeenCalledWith('acme', sendMedia.number, 'audio', sendMedia.media, 'audio/ogg', expect.any(Object));
  });

  it('reports an instance that exists but is not connected', async () => {
    const { app } = await createSendTestApp('close');

    const response = await request(app)
      .post('/message/sendMedia/acme')
      .set('apikey', API_KEY)
      .send(sendMedia)
      .expect(400);

    expect(response.body.response.message).toBe('The "acme" instance is not connected');
  });

  it('accepts base64 media above the default JSON limit', async () => {
    const { instanceService, app } = await createSendTestApp();
    const media = 'A'.repeat(1024 * 1024);

    await request(app)
      .post('/message/sendMedia/acme')
      .set('apikey', API_KEY)
      .send({ ...sendMedia, media })
      .expect(201);

    expect(instanceService.sendMedia).toHaveBeenCalledWith(
      'acme',
      sendMedia.number,
      sendMedia.mediatype,
      media,
      sendMedia.mimetype,
      expect.any(Object),
    );
  });

  it('maps invalid media input to the API error envelope', async () => {
    const { instanceService, app } = await createSendTestApp();
    vi.mocked(instanceService.sendMedia).mockRejectedValueOnce(new InvalidMediaError('"media" must be an http(s) URL or valid base64'));

    const response = await request(app)
      .post('/message/sendMedia/acme')
      .set('apikey', API_KEY)
      .send(sendMedia)
      .expect(400);

    expect(response.body.response.message).toBe('"media" must be an http(s) URL or valid base64');
  });

  it('answers 404 with the reference wording for an unknown instance', async () => {
    await expectMissingInstance('/message/sendMedia/ghost', sendMedia);
  });

  it('requires the api key', async () => {
    const { instanceService, app } = await createSendTestApp();

    await request(app).post('/message/sendMedia/acme').send(sendMedia).expect(401);

    expect(instanceService.sendMedia).not.toHaveBeenCalled();
  });

  it('sends once for a repeated Idempotency-Key and replays the same body', async () => {
    const { instanceService, app } = await createSendTestApp();

    const first = await request(app)
      .post('/message/sendMedia/acme')
      .set('apikey', API_KEY)
      .set('Idempotency-Key', 'order-42')
      .send(sendMedia)
      .expect(201);

    const replay = await request(app)
      .post('/message/sendMedia/acme')
      .set('apikey', API_KEY)
      .set('Idempotency-Key', 'order-42')
      .send(sendMedia)
      .expect(201);

    expect(instanceService.sendMedia).toHaveBeenCalledOnce();
    expect(replay.body).toEqual(first.body);
  });
});

describe('POST /message/sendWhatsAppAudio/:instanceName', () => {
  it('answers 201 with the normalized voice note', async () => {
    const { instanceService, app } = await createSendTestApp();

    const response = await request(app)
      .post('/message/sendWhatsAppAudio/acme')
      .set('apikey', API_KEY)
      .send(sendAudio)
      .expect(201);

    expect(response.body).toEqual(sendAudioResponse);
    expect(instanceService.sendAudio).toHaveBeenCalledWith('acme', sendAudio.number, sendAudio.audio, {
      encoding: undefined,
      delay: sendAudio.delay,
      presence: undefined,
    });
  });

  it('takes an uploaded file as the audio and coerces its string fields', async () => {
    const { instanceService, app } = await createSendTestApp();
    const file = Buffer.from('fake-voice-note');

    await request(app)
      .post('/message/sendWhatsAppAudio/acme')
      .set('apikey', API_KEY)
      .field('number', sendAudio.number)
      .field('delay', '1200')
      .field('encoding', 'false')
      .attach('file', file, 'voice.mp3')
      .expect(201);

    expect(instanceService.sendAudio).toHaveBeenCalledWith('acme', sendAudio.number, file.toString('base64'), {
      encoding: false,
      delay: 1200,
      presence: undefined,
    });
  });

  it.each([
    ['a missing number', { ...sendAudio, number: undefined }],
    ['a missing audio payload', { ...sendAudio, audio: undefined }],
    ['a non-boolean encoding', { ...sendAudio, encoding: 'maybe' }],
    ['no body at all', {}],
  ])('rejects %s', async (_label, body) => {
    const { instanceService, app } = await createSendTestApp();

    await request(app).post('/message/sendWhatsAppAudio/acme').set('apikey', API_KEY).send(body).expect(400);

    expect(instanceService.sendAudio).not.toHaveBeenCalled();
  });

  it('rejects malformed multipart uploads as caller errors', async () => {
    const { instanceService, app } = await createSendTestApp();

    await request(app)
      .post('/message/sendWhatsAppAudio/acme')
      .set('apikey', API_KEY)
      .field('number', sendAudio.number)
      .attach('unexpected', Buffer.from('audio'), 'voice.ogg')
      .expect(400);

    expect(instanceService.sendAudio).not.toHaveBeenCalled();
  });

  it('reports an oversized uploaded file as 413', async () => {
    const { instanceService, app } = await createSendTestApp();

    await request(app)
      .post('/message/sendWhatsAppAudio/acme')
      .set('apikey', API_KEY)
      .field('number', sendAudio.number)
      .attach('file', Buffer.alloc(MAX_OUTBOUND_MEDIA_BYTES + 1), 'voice.ogg')
      .expect(413);

    expect(instanceService.sendAudio).not.toHaveBeenCalled();
  });

  it('reports an unusable audio payload as a caller problem, not a 500', async () => {
    const { instanceService, app } = await createSendTestApp();
    instanceService.sendAudio = vi.fn(async () => {
      throw new InvalidMediaError('"audio" could not be converted: Invalid data found when processing input');
    });

    const response = await request(app)
      .post('/message/sendWhatsAppAudio/acme')
      .set('apikey', API_KEY)
      .send(sendAudio)
      .expect(400);

    expect(response.body.response.message).toContain('could not be converted');
  });

  it('reports an unknown instance', () => expectMissingInstance('/message/sendWhatsAppAudio/ghost', sendAudio));

  it('requires the api key', async () => {
    const { instanceService, app } = await createSendTestApp();

    await request(app).post('/message/sendWhatsAppAudio/acme').send(sendAudio).expect(401);

    expect(instanceService.sendAudio).not.toHaveBeenCalled();
  });
});
