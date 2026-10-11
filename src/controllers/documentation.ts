import { loadOpenApiDocument } from '../openapi';
import type { Request, Response } from 'express';

export function swaggerJson(_req: Request, res: Response): void {
  res.json(loadOpenApiDocument());
}

export function redoc(_req: Request, res: Response): void {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Relaybox API documentation</title>
</head>
<body>
    <redoc spec-url="/swagger.json"></redoc>
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
</body>
</html>`);
}
