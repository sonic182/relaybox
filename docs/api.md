# JSON API

Relaybox exposes an Evolution-compatible JSON API. All API routes require the
`apikey: YOUR_API_KEY` request header.

| Method | Path |
| --- | --- |
| POST | `/instance/create` |
| GET | `/instance/fetchInstances` |
| GET | `/instance/connectionState/{instanceName}` |
| GET | `/instance/connect/{instanceName}` |
| POST | `/instance/rename/{instanceName}` |
| POST | `/instance/disconnect/{instanceName}` |
| DELETE | `/instance/logout/{instanceName}` |
| DELETE | `/instance/delete/{instanceName}` |
| POST | `/message/sendText/{instanceName}` |
| POST | `/message/sendMedia/{instanceName}` |
| POST | `/message/sendWhatsAppAudio/{instanceName}` |
| POST | `/chat/findMessages/{instanceName}` |
| POST | `/chat/getBase64FromMediaMessage/{instanceName}` |
| POST | `/chat/updateMessage/{instanceName}` |
| POST | `/webhook/set/{instanceName}` |
| GET | `/webhook/find/{instanceName}` |
| POST | `/settings/set/{instanceName}` |
| GET | `/settings/find/{instanceName}` |

Interactive API documentation is public at `/redoc`. The OpenAPI source is available at
`/swagger.yml` and as JSON at `/swagger.json`.
