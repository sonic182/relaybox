# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] 2026-10-11

First tagged release.

### Added
- Dashboard to create, connect, rename, disconnect and delete WhatsApp instances, with chat history, media, message sending and webhook configuration.
- Evolution-compatible JSON API (reference 2.4.0 shapes) for instances, messages, chats, webhooks and settings, authenticated with the `apikey` header. OpenAPI spec served at `/redoc` and `/swagger.json`.
- Outbound webhooks, optionally signed.
- History sync of the chats WhatsApp sends while pairing, off by default.
- Remote control over an outbound WebSocket.
- MCP server exposing the API, chat history and media as tools.
- PostgreSQL persistence through ZenStack, with committed migrations.
- Dockerfile and `docker-compose.yml` setup.

[Unreleased]: https://github.com/sonic182/relaybox/compare/0.1.0...HEAD
[0.1.0]: https://github.com/sonic182/relaybox/compare/b3c72c1..0.1.0
