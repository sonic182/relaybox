import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

let document: unknown;

/** The sole OpenAPI document, shared by documentation and control validation. */
export function loadOpenApiDocument(): unknown {
  document ??= parse(readFileSync(join(process.cwd(), 'public', 'swagger.yml'), 'utf8'));
  return document;
}
