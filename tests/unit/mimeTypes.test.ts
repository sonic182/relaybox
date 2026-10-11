import { describe, expect, it } from 'vitest';
import { capFileName, fileNameFromUrl, inferMimetype, mimeFromName, sniffMime, withExtension } from '../../src/mimeTypes';

const bytes = (...values: number[]) => Buffer.from(values);

describe('sniffMime', () => {
  it.each([
    ['application/pdf', Buffer.from('%PDF-1.7')],
    ['image/png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d)],
    ['image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe0)],
    ['image/gif', Buffer.from('GIF89a')],
    ['image/webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 ')],
    ['video/mp4', Buffer.from('\0\0\0\x18ftypmp42')],
    ['audio/mp4', Buffer.from('\0\0\0\x18ftypM4A ')],
    ['video/3gpp', Buffer.from('\0\0\0\x18ftyp3gp4')],
    ['video/mp4', Buffer.from('\0\0\0\x18ftypisom')],
    ['video/mp4', Buffer.from('\0\0\0\x18ftypavc1')],
    ['video/mp4', Buffer.from('\0\0\0\x18ftypmp41')],
    ['audio/ogg', Buffer.from('OggS\0')],
    ['audio/mpeg', Buffer.from('ID3\x04')],
    ['application/zip', Buffer.from('PK\x03\x04')],
  ])('recognises %s', (mime, buffer) => {
    expect(sniffMime(buffer)).toBe(mime);
  });

  it('does not call other ISO-BMFF brands mp4', () => {
    expect(sniffMime(Buffer.from('\0\0\0\x18ftypheic'))).toBeUndefined();
    expect(sniffMime(Buffer.from('\0\0\0\x18ftypavif'))).toBeUndefined();
  });

  it('returns undefined for unknown bytes', () => {
    expect(sniffMime(Buffer.from('plain text'))).toBeUndefined();
  });
});

describe('mimeFromName', () => {
  it('is case-insensitive and tolerates trailing whitespace', () => {
    expect(mimeFromName('INFORME.PDF')).toBe('application/pdf');
    expect(mimeFromName('informe.pdf ')).toBe('application/pdf');
  });

  it('does not resolve inherited object members as extensions', () => {
    expect(mimeFromName('a.constructor')).toBeUndefined();
    expect(mimeFromName('a.toString'.toLowerCase())).toBeUndefined();
    expect(inferMimetype({ fileName: 'x.constructor', mediatype: 'document', buffer: Buffer.from('plain') })).toBeUndefined();
    expect(inferMimetype({ url: 'https://x.test/a.constructor', mediatype: 'document', buffer: Buffer.from('plain') })).toBeUndefined();
  });
});

describe('fileNameFromUrl', () => {
  it('decodes the last path segment and ignores the query', () => {
    expect(fileNameFromUrl('https://x.test/a/informe%20final.pdf?sig=1')).toBe('informe final.pdf');
  });

  it('strips separators, control characters, and bidi overrides, and caps the length', () => {
    expect(fileNameFromUrl('https://x.test/a%2F..%2Fb%00.pdf')).toBe('a..b.pdf');
    expect(fileNameFromUrl('https://x.test/invoice%E2%80%AEfdp.exe')).toBe('invoicefdp.exe');
  });

  it('strips invisible format characters and trailing dots or spaces', () => {
    expect(fileNameFromUrl('https://x.test/a%E2%80%8Bb%E2%80%8E.pdf')).toBe('ab.pdf');
    expect(fileNameFromUrl('https://x.test/a%C2%ADb.pdf')).toBe('ab.pdf');
    expect(fileNameFromUrl('https://x.test/a.pdf.%20')).toBe('a.pdf');
  });

  it('keeps the whole name so the extension still identifies the type', () => {
    expect(fileNameFromUrl(`https://x.test/${'a'.repeat(400)}.pdf`)).toHaveLength(404);
  });

  it('returns undefined when only dots or nothing usable remain', () => {
    expect(fileNameFromUrl('https://x.test/%2E%2E')).toBeUndefined();
    expect(fileNameFromUrl('https://x.test/%00')).toBeUndefined();
  });

  it('returns undefined for a trailing slash', () => {
    expect(fileNameFromUrl('https://x.test/a/')).toBeUndefined();
  });

  it('keeps the raw segment when it holds a bare percent sign or a malformed escape', () => {
    expect(fileNameFromUrl('https://x.test/100%.pdf')).toBe('100%.pdf');
    expect(fileNameFromUrl('https://x.test/%E0%A4%A')).toBe('%E0%A4%A');
    expect(inferMimetype({ url: 'https://x.test/Descuento 50%.docx', mediatype: 'document', buffer: Buffer.from('PK') })).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });
});

describe('withExtension', () => {
  it('appends the extension a mimetype maps to only when the name has none', () => {
    expect(withExtension('download', 'application/pdf')).toBe('download.pdf');
    expect(withExtension('photo', 'image/jpeg')).toBe('photo.jpg');
    expect(withExtension('q3.docx', 'application/pdf')).toBe('q3.docx');
    expect(withExtension('download', 'application/x-unknown')).toBe('download');
  });
});

describe('capFileName', () => {
  it('handles a name with no extension or an over-long one', () => {
    expect([...capFileName('a'.repeat(400))]).toHaveLength(255);
    const capped = capFileName(`${'a'.repeat(300)}.${'b'.repeat(20)}`);
    expect([...capped]).toHaveLength(255);
  });

  it('leaves a short name alone', () => {
    expect(capFileName('a.pdf')).toBe('a.pdf');
  });

  it('caps at 255 code points and keeps the extension', () => {
    const capped = capFileName(`${'a'.repeat(400)}.pdf`);

    expect([...capped]).toHaveLength(255);
    expect(capped.endsWith('.pdf')).toBe(true);
  });

  it('never splits a surrogate pair', () => {
    const capped = capFileName(`${'😀'.repeat(300)}.pdf`);

    expect([...capped]).toHaveLength(255);
    expect(capped).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe('inferMimetype', () => {
  const pdf = Buffer.from('%PDF-1.7');

  it('prefers the explicit mimetype, then fileName, url, content-type, and bytes in that order', () => {
    const all = { fileName: 'a.docx', url: 'https://x.test/b.xlsx', contentType: 'application/x-custom', mediatype: 'document' as const, buffer: pdf };

    expect(inferMimetype({ ...all, mimetype: 'text/x-custom' })).toBe('text/x-custom');
    expect(inferMimetype(all)).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(inferMimetype({ ...all, fileName: undefined })).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(inferMimetype({ ...all, fileName: undefined, url: undefined })).toBe('application/x-custom');
    expect(inferMimetype({ ...all, fileName: undefined, url: undefined, contentType: undefined })).toBe('application/pdf');
    expect(inferMimetype({ mediatype: 'document', buffer: pdf })).toBe('application/pdf');
  });

  it('trims an explicit mimetype and ignores a blank one', () => {
    expect(inferMimetype({ mimetype: ' application/pdf ', mediatype: 'document', buffer: Buffer.from('x') })).toBe('application/pdf');
    expect(inferMimetype({ mimetype: '  ', mediatype: 'document', buffer: pdf })).toBe('application/pdf');
  });

  it('ignores download-style content-types', () => {
    for (const contentType of ['application/x-download', 'application/force-download', 'application/download']) {
      expect(inferMimetype({ contentType, mediatype: 'document', buffer: pdf })).toBe('application/pdf');
    }
  });

  it('ignores a generic or parameterised content-type', () => {
    expect(inferMimetype({ contentType: 'application/octet-stream', mediatype: 'document', buffer: pdf })).toBe('application/pdf');
    expect(inferMimetype({ contentType: 'Image/PNG; charset=binary', mediatype: 'image', buffer: Buffer.alloc(0) })).toBe('image/png');
  });

  it.each([
    ['html', 'text/html'],
    ['an svg', 'image/svg+xml'],
    ['xml', 'application/xml'],
    ['text xml', 'text/xml'],
    ['xhtml', 'application/xhtml+xml'],
    ['javascript', 'text/javascript'],
    ['a malformed value', 'foo'],
    ['a list of values', 'audio/mpeg, audio/mp4'],
  ])('does not trust a response content-type that is %s', (_label, contentType) => {
    expect(inferMimetype({ contentType, mediatype: 'document', buffer: Buffer.from('plain') })).toBeUndefined();
    expect(inferMimetype({ contentType, mediatype: 'document', buffer: pdf })).toBe('application/pdf');
  });

  it('skips an inferred type that does not fit the media kind and moves to the next source', () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d);

    expect(inferMimetype({ fileName: 'a.pdf', mediatype: 'image', buffer: Buffer.from('plain') })).toBeUndefined();
    expect(inferMimetype({ fileName: 'a.pdf', mediatype: 'image', buffer: png })).toBe('image/png');
    expect(inferMimetype({ contentType: 'application/pdf', mediatype: 'image', buffer: pdf })).toBeUndefined();
    expect(inferMimetype({ contentType: 'audio/mpeg', mediatype: 'video', buffer: png })).toBeUndefined();
  });

  it('does not check an explicit mimetype against the media kind', () => {
    expect(inferMimetype({ mimetype: 'application/pdf', mediatype: 'image', buffer: pdf })).toBe('application/pdf');
  });

  it('lets a document take any non-active content-type', () => {
    expect(inferMimetype({ contentType: 'application/x-custom', mediatype: 'document', buffer: Buffer.from('plain') })).toBe('application/x-custom');
  });

  it('returns undefined when nothing identifies the payload', () => {
    expect(inferMimetype({ fileName: 'notes', mediatype: 'document', buffer: Buffer.from('plain') })).toBeUndefined();
  });
});
