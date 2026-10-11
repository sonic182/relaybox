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
    <script
        src="https://cdn.jsdelivr.net/npm/redoc@2.5.4/bundles/redoc.standalone.js"
        integrity="sha384-w447zOpYfw/1Tv/5AK9NfHTlQIqE3RVR6KY62jCyy9zNDgO64cMwGGP1Fj0zJVf5"
        crossorigin="anonymous"></script>
</body>
</html>`);
}
