import type { Request, Response } from 'express';
import { toSentChatMessage, type ChatService } from '../chats';
import { isValidName, type InboundMessage, type InstanceService } from '../instances';
import { resolveStoredMediaPath } from '../mediaAccess';
import { sendStoredMedia } from './mediaResponse';
import { readInstanceName } from './requests';
import { chatsPage, conversationPanel, messageTimeline } from '../views';

const EMPTY_PAGE = { messages: [], cursor: null };

function readJid(req: Request): string | undefined {
  // A JID travels as a query parameter: it contains `@` and, for a group, a `-`.
  const jid = req.query.jid;
  return typeof jid === 'string' && jid.trim() ? jid.trim() : undefined;
}

function readChatTarget(req: Request): { name: string; jid: string } | undefined {
  const { name } = req.params;
  const jid = readJid(req);
  return isValidName(name) && jid ? { name, jid } : undefined;
}

function requireChatTarget(req: Request, res: Response): { name: string; jid: string } | undefined {
  const target = readChatTarget(req);
  if (target) return target;

  res.status(400).send('Invalid chat');
  return undefined;
}

/** HTML adapter for the chat browser: reads projections, and sends through the instance. */
export function createChatsController(service: ChatService, instances: InstanceService) {
  async function show(req: Request, res: Response): Promise<void> {
    const name = readInstanceName(req, res);
    if (!name) return;

    const jid = readJid(req);
    const [chatPage, page] = await Promise.all([
      service.listChats(name),
      jid ? service.listMessages(name, jid) : Promise.resolve(EMPTY_PAGE),
    ]);

    res.send(chatsPage(name, chatPage.chats, jid, page));
  }

  /** Pushes receipt changes for the selected chat; EventSource reconnects when needed. */
  function events(req: Request, res: Response): void {
    const target = requireChatTarget(req, res);
    if (!target) return;
    const { name } = target;

    res.set({
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
    });
    res.flushHeaders();

    const unsubscribe = instances.subscribe((event) => {
      // A receipt can arrive keyed by the LID form while the page jid is the phone
      // form (or vice versa); match by instance only — the client looks up the label
      // by keyId, so a receipt for another chat simply has no label to update.
      if (event.type !== 'message-updated' || event.instance.name !== name) return;
      res.write(`event: message-status\ndata: ${JSON.stringify({ keyId: event.update.key.id, status: event.update.status })}\n\n`);
    });
    req.once('close', unsubscribe);
  }

  /** Redirects the browser to WhatsApp's current profile-picture CDN URL. */
  async function avatar(req: Request, res: Response): Promise<void> {
    const target = requireChatTarget(req, res);
    if (!target) return;
    const { name, jid } = target;

    try {
      const url = await instances.getProfilePictureUrl(name, jid);
      if (url) res.redirect(url);
      else res.status(404).end();
    } catch {
      // A missing avatar or offline socket is only a visual fallback, never a page error.
      res.status(404).end();
    }
  }

  /** htmx fragment: the page of history before `before`. */
  async function messages(req: Request, res: Response): Promise<void> {
    const target = requireChatTarget(req, res);
    if (!target) return;
    const { name, jid } = target;

    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    res.send(messageTimeline(name, jid, await service.listMessages(name, jid, { before })));
  }

  async function send(req: Request, res: Response): Promise<void> {
    const { name } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const jid = typeof body.jid === 'string' ? body.jid.trim() : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';

    if (!isValidName(name) || !jid) {
      res.status(400).send('Invalid chat');
      return;
    }
    if (!text) {
      const page = await service.listMessages(name, jid);
      res.set('HX-Retarget', '#conversation').set('HX-Reswap', 'outerHTML').status(400).send(conversationPanel(name, jid, page, { error: 'Write something first.' }));
      return;
    }

    let sent: InboundMessage | undefined;
    let error: string | undefined;
    try {
      sent = await instances.sendText(name, jid, text);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not send the message';
    }

    const page = await service.listMessages(name, jid);
    if (error) {
      // 400 is swapped by htmx here on purpose; see the config in Layout.
      res.set('HX-Retarget', '#conversation').set('HX-Reswap', 'outerHTML').status(400).send(conversationPanel(name, jid, page, { error, draft: text }));
      return;
    }

    // Append only the new bubble: replacing the panel would reset its scroll position and
    // reconnect its receipt stream. The stored echo can win the race with sendText.
    const message = page.messages.find((entry) => entry.keyId === sent?.key.id) ?? (sent && toSentChatMessage(sent));
    res.send(messageTimeline(name, jid, { messages: message ? [message] : [], cursor: null }));
  }

  /** The bytes behind a timeline `<img>`/`<video>`/`<audio>`/link. */
  async function media(req: Request, res: Response): Promise<void> {
    const { name } = req.params;
    const keyId = typeof req.params.keyId === 'string' ? req.params.keyId : undefined;
    if (!isValidName(name) || !keyId) {
      res.status(400).send('Invalid media request');
      return;
    }

    const found = await service.getMedia(name, keyId);
    // The path comes from our own database, but keep the send inside the media dir.
    const file = found ? resolveStoredMediaPath(name, found.path) : undefined;
    if (!found || !file) {
      res.status(404).send('Not found');
      return;
    }

    sendStoredMedia(res, file, found);
  }

  return { show, events, avatar, messages, send, media };
}
