import type { Response } from 'express';

/** Types and sends a stored media file; documents download, everything else renders inline. */
export function sendStoredMedia(
  res: Response,
  file: string,
  media: { mimetype: string; messageType: string },
): void {
  res.type(media.mimetype);
  res.set('X-Content-Type-Options', 'nosniff');
  // Even an explicitly browser-renderable media type must not execute on our origin.
  res.set('Content-Security-Policy', "sandbox; default-src 'none'");
  if (media.messageType === 'documentMessage') res.attachment();
  res.sendFile(file);
}
