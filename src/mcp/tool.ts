import { z } from 'zod';
import type { ControlResponse, ControlService } from '../api/control';
import { apiErrorResponse, mapApiError, type ApiError } from '../api/error-core';

/** Text and image blocks are the only content this server emits. */
export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

/**
 * A tool as this server defines it: metadata for discovery, a zod schema for the wire, and a
 * plain handler. Handlers are transport-free so a unit test can call them directly.
 */
export type McpTool<S extends z.ZodType = z.ZodType> = {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  readOnly?: boolean;
  destructive?: boolean;
  handler: (args: z.infer<S>) => Promise<ToolResult> | ToolResult;
};

/** Erases the schema generic so heterogeneous tools share one array type; the handler keeps
 * its inferred argument type at the definition site. */
export function defineTool<S extends z.ZodType>(tool: McpTool<S>): McpTool {
  return tool as unknown as McpTool;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A tool result carrying JSON as text, with the same object as structured content when it is one. */
export function jsonResult(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], ...(isRecord(value) ? { structuredContent: value } : {}) };
}

/**
 * Maps a control-service result to a tool result. A status of 400+ is an error, with the
 * reference envelope preserved both as text and structured content.
 */
export function controlResultToToolResult(response: ControlResponse): ToolResult {
  const text = JSON.stringify(response.body, null, 2);
  const structured = isRecord(response.body) ? response.body : undefined;
  return {
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {}),
    ...(response.status >= 400 ? { isError: true } : {}),
  };
}

/** Builds the dispatch helper every control-backed tool shares. */
export function controlRunner(control: ControlService) {
  return (method: string, path: string, body?: unknown) =>
    runTool(async () => controlResultToToolResult(await control.execute({ method, path, body })));
}

/** Maps an `ApiError` to a tool error, matching the JSON API's envelope. */
export function apiErrorToToolResult(error: ApiError): ToolResult {
  return controlResultToToolResult(apiErrorResponse(error));
}

/** Runs a handler, turning thrown API errors into tool errors; anything else rethrows. */
export async function runTool(handler: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await handler();
  } catch (error) {
    const mapped = mapApiError(error);
    if (mapped) return apiErrorToToolResult(mapped);
    throw error;
  }
}

/** A `data:image/png;base64,...` URL as an MCP image block, or undefined for anything else. */
export function dataUrlToImage(dataUrl: unknown): { type: 'image'; data: string; mimeType: string } | undefined {
  if (typeof dataUrl !== 'string') return undefined;
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  return match ? { type: 'image', data: match[2], mimeType: match[1] } : undefined;
}
