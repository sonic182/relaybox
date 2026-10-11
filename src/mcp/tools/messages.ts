import { z } from 'zod';
import { MCP_INLINE_MEDIA_BYTES } from '../../config';
import { badRequest } from '../../api/errors';
import { readSendAudio, readSendMedia, readSendText, sendOptions, MEDIA_TYPES, PRESENCES } from '../../api/inputs';
import { requireApiInstance } from '../../api/instances';
import type { InstanceService } from '../../instances';
import type { SendService } from '../../sends';
import { defineTool, jsonResult, runTool, type McpTool } from '../tool';

const instanceName = z.string().min(1).describe('Instance name ([a-zA-Z0-9_-], 1-32 characters).');

const quoted = z.object({
  key: z.object({
    id: z.string(),
    remoteJid: z.string().optional(),
    fromMe: z.boolean().optional(),
    participant: z.string().optional(),
  }),
  message: z.record(z.string(), z.unknown()).optional(),
}).describe('Message to reply to; only key.id is required when we already stored it.');

const sendContext = {
  quoted: quoted.optional(),
  mentioned: z.array(z.string()).optional().describe('Numbers or JIDs to mention (groups only).'),
  mentionsEveryOne: z.boolean().optional(),
};

const sendOptionsShape = {
  delay: z.number().int().nonnegative().optional().describe('Simulate presence for this many milliseconds.'),
  presence: z.enum(PRESENCES).optional(),
};

/** Exactly one of a URL or an inline base64 payload, capped so a model cannot flood the call. */
function mediaSource(url: string | undefined, base64: string | undefined, urlField: string, base64Field: string): string {
  if (url && base64) throw badRequest(`Provide either "${urlField}" or "${base64Field}", not both`);
  if (!url && !base64) throw badRequest(`"${urlField}" or "${base64Field}" is required`);
  if (base64) {
    const bytes = Buffer.from(base64, 'base64').byteLength;
    if (MCP_INLINE_MEDIA_BYTES === 0 || bytes > MCP_INLINE_MEDIA_BYTES) {
      throw badRequest(`"${base64Field}" exceeds the ${MCP_INLINE_MEDIA_BYTES}-byte inline limit; send a URL instead`);
    }
  }
  return (url ?? base64) as string;
}

/** Message-sending tools. They reuse the HTTP readers so both surfaces reject identically. */
export function createMessageTools(instances: InstanceService, sends: SendService): McpTool[] {
  return [
    defineTool({
      name: 'send_text',
      title: 'Send text',
      description: 'Send a WhatsApp text message to a number or JID. This delivers a real message and cannot be undone. Returns the stored message.',
      inputSchema: z.object({
        instanceName,
        number: z.string().describe('Bare number or qualified JID; a group JID sends to the group.'),
        text: z.string().min(1).describe('Message body.'),
        linkPreview: z.boolean().optional().describe('Show a link preview when the text contains a URL.'),
        idempotencyKey: z.string().optional().describe('Retry-safe key; the send runs at most once per key.'),
        ...sendOptionsShape,
        ...sendContext,
      }),
      handler: async (args) => runTool(async () => {
        const instance = requireApiInstance(instances, args.instanceName);
        const input = readSendText(args);
        const message = await sends.once(instance.id, args.idempotencyKey, () =>
          instances.sendText(args.instanceName, input.number, input.text, {
            ...sendOptions(input),
            linkPreview: input.linkPreview,
          }),
        );
        return jsonResult(message);
      }),
    }),

    defineTool({
      name: 'send_media',
      title: 'Send media',
      description: 'Send an image, video, document or audio file to a number or JID. Provide exactly one of mediaUrl (preferred) or mediaBase64. This delivers a real message and cannot be undone. For a push-to-talk voice note use send_audio.',
      inputSchema: z.object({
        instanceName,
        number: z.string().describe('Bare number or qualified JID; a group JID sends to the group.'),
        mediatype: z.enum(MEDIA_TYPES),
        mediaUrl: z.string().url().optional().describe('http(s) URL the server fetches.'),
        mediaBase64: z.string().optional().describe('Inline base64 payload for small files.'),
        mimetype: z.string().optional().describe('MIME type of the file, for example image/png; inferred when omitted.'),
        caption: z.string().optional().describe('Text shown with the media.'),
        fileName: z.string().optional().describe('File name shown for documents.'),
        idempotencyKey: z.string().optional().describe('Retry-safe key; the send runs at most once per key.'),
        ...sendOptionsShape,
        ...sendContext,
      }),
      handler: async (args) => runTool(async () => {
        const instance = requireApiInstance(instances, args.instanceName);
        const input = readSendMedia({
          ...args,
          media: mediaSource(args.mediaUrl, args.mediaBase64, 'mediaUrl', 'mediaBase64'),
        });
        const message = await sends.once(instance.id, args.idempotencyKey, () =>
          instances.sendMedia(args.instanceName, input.number, input.mediatype, input.media, input.mimetype, {
            ...sendOptions(input),
            caption: input.caption,
            fileName: input.fileName,
          }),
        );
        return jsonResult(message);
      }),
    }),

    defineTool({
      name: 'send_audio',
      title: 'Send voice note',
      description: 'Send a push-to-talk voice note, transcoded to ogg/opus, to a number or JID. Provide exactly one of audioUrl (preferred) or audioBase64. This delivers a real message and cannot be undone.',
      inputSchema: z.object({
        instanceName,
        number: z.string().describe('Bare number or qualified JID; a group JID sends to the group.'),
        audioUrl: z.string().url().optional().describe('http(s) URL the server fetches.'),
        audioBase64: z.string().optional().describe('Inline base64 payload for small files.'),
        encoding: z.boolean().optional().describe('false sends the bytes untouched; default true transcodes.'),
        idempotencyKey: z.string().optional().describe('Retry-safe key; the send runs at most once per key.'),
        ...sendOptionsShape,
        ...sendContext,
      }),
      handler: async (args) => runTool(async () => {
        const instance = requireApiInstance(instances, args.instanceName);
        const input = readSendAudio({
          ...args,
          audio: mediaSource(args.audioUrl, args.audioBase64, 'audioUrl', 'audioBase64'),
        }, undefined, false);
        const message = await sends.once(instance.id, args.idempotencyKey, () =>
          instances.sendAudio(args.instanceName, input.number, input.audio, {
            ...sendOptions(input),
            encoding: input.encoding,
          }),
        );
        return jsonResult(message);
      }),
    }),
  ];
}
