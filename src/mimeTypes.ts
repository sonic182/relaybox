import type { MediaType } from './contracts/evolution';

// ponytail: fixed table of what senders actually attach; extend it when a caller hits a gap
// rather than pulling in the full `mime-types` database.
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  xml: 'application/xml',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
};

const GENERIC_MIME = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/download',
  'application/x-download',
  'application/force-download',
]);

/** Leading-byte signatures; ZIP-based Office files sniff as plain zip, so extensions must win. */
const SIGNATURES: [mime: string, offset: number, bytes: string][] = [
  ['application/pdf', 0, '%PDF'],
  ['image/png', 0, '\x89PNG'],
  ['image/jpeg', 0, '\xff\xd8\xff'],
  ['image/gif', 0, 'GIF8'],
  ['audio/ogg', 0, 'OggS'],
  ['audio/mpeg', 0, 'ID3'],
  ['application/zip', 0, 'PK\x03\x04'],
];

export function mimeFromName(name: string): string | undefined {
  const ext = /\.([A-Za-z0-9]+)\s*$/.exec(name)?.[1]?.toLowerCase();
  // `hasOwn`: an extension such as "constructor" would otherwise resolve to an inherited member.
  return ext && Object.hasOwn(MIME_BY_EXT, ext) ? MIME_BY_EXT[ext] : undefined;
}

const MP4_BRAND = /^(isom|iso\d|mp4\d|avc1)$/;

export function sniffMime(buffer: Buffer): string | undefined {
  // ISO-BMFF is a container: HEIC, AVIF, 3GP and M4A share `ftyp`, so only known brands count.
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (brand === 'M4A ') return 'audio/mp4';
    if (/^3gp\d$/.test(brand)) return 'video/3gpp';
    return MP4_BRAND.test(brand) ? 'video/mp4' : undefined;
  }
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return SIGNATURES.find(([, offset, bytes]) => buffer.subarray(offset, offset + bytes.length).toString('latin1') === bytes)?.[0];
}

// Control and format characters (zero-width, bidi marks and overrides, tags), line/paragraph
// separators, and path separators: anything that could disguise the name a recipient sees.
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}/\\]/gu;

/**
 * Last path segment of a URL, decoded and stripped of unsafe characters and trailing dots or
 * spaces; undefined when nothing usable remains. Not truncated, so the extension still shows.
 */
export function fileNameFromUrl(url: string): string | undefined {
  let segment: string;
  try {
    segment = new URL(url).pathname.split('/').pop() ?? '';
  } catch {
    return undefined;
  }
  // A bare `%` is not an escape; keep the raw segment rather than losing the name and its extension.
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // keep the raw segment
  }
  return decoded.replace(UNSAFE_NAME_CHARS, '').trim().replace(/[.\s]+$/u, '') || undefined;
}

/** Appends the extension `mimetype` maps to when `name` has none, so a client can open a `/download` URL's file. */
export function withExtension(name: string, mimetype: string): string {
  if (/\.[A-Za-z0-9]+$/.test(name)) return name;
  const ext = Object.entries(MIME_BY_EXT).find(([, mime]) => mime === mimetype)?.[0];
  return ext ? `${name}.${ext}` : name;
}

const MAX_FILE_NAME = 255;

/** Caps a name at 255 code points, keeping a short extension so the type survives. */
export function capFileName(name: string): string {
  const points = [...name];
  if (points.length <= MAX_FILE_NAME) return name;
  const ext = /\.[A-Za-z0-9]{1,16}$/.exec(name)?.[0] ?? '';
  return points.slice(0, MAX_FILE_NAME - ext.length).join('') + ext;
}

/** The type prefix each `sendMedia` kind implies; documents take any other type. */
const FAMILY: Record<string, string> = { image: 'image/', video: 'video/', audio: 'audio/' };
const WELL_FORMED_MIME = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
// Types a browser would render as active content when the chat media route serves them back.
const ACTIVE_MIME = /^(text\/(html|xml|javascript)|application\/(xml|javascript)|[^/]+\/[^/]*\+xml)$/;

/** A remote host chooses this header, so it only counts when it is well-formed and not active content. */
function trustedContentType(contentType: string | undefined): string | undefined {
  const declared = contentType?.split(';')[0]?.trim().toLowerCase();
  if (!declared || GENERIC_MIME.has(declared) || !WELL_FORMED_MIME.test(declared) || ACTIVE_MIME.test(declared)) return undefined;
  return declared;
}

export type InferMimetypeInput = {
  mimetype?: string;
  fileName?: string;
  /** The `media` URL, when the payload was fetched rather than sent inline. */
  url?: string;
  /** Response `content-type` header of that fetch. */
  contentType?: string;
  mediatype: MediaType;
  buffer: Buffer;
};

/**
 * Explicit mimetype, then `fileName` extension, URL path extension, a trusted response
 * `content-type`, and finally the payload's leading bytes. Every inferred candidate must fit the
 * media kind (an image is never `application/pdf`); a misfit is skipped for the next source.
 */
export function inferMimetype({ mimetype, fileName, url, contentType, mediatype, buffer }: InferMimetypeInput): string | undefined {
  const explicit = mimetype?.trim();
  if (explicit) return explicit;

  const candidates = [
    fileName && mimeFromName(fileName),
    url && mimeFromName(fileNameFromUrl(url) ?? ''),
    trustedContentType(contentType),
    sniffMime(buffer),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate) && (candidate as string).startsWith(FAMILY[mediatype] ?? ''));
}
