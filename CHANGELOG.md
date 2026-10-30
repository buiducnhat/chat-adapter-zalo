# chat-adapter-zalo

## 0.2.0

Aligned with the current Zalo Bot Platform docs and Chat SDK adapter guide (`chat` 4.43).

### Added

- Rich text: markdown/AST messages are sent with `text_styles` (bold, italic, strikethrough, headings); style runs are re-based when long messages are chunked
- Voice: inbound `message.voice.received` (`voice_url` → audio attachment) and outbound `sendVoice` (`.aac`, 1-1 only)
- Outbound media through standard `attachments` (`image` → `sendPhoto`, `audio` → `sendVoice`); `sendSticker` method
- Group chats: `GROUP` messages are flagged `isMention`, `isDM` reflects seen groups
- Sticker image `url` exposed as attachment; `message_type` typed on inbound messages

### Changed

- Inbound photos read `photo_url` (falls back to legacy `photo`)
- `persistMessageHistory` → `persistThreadHistory`; logger comes from `chat.getLogger("zalo")`
- `chat` peer range is `^4.43.0`; `@chat-adapter/shared` is now a regular dependency
- Tables and code are no longer wrapped in markdown fences (Zalo shows them literally)
- `ZaloSendResponse.message_type` removed (no longer returned by the API)

### Tooling

- Dependencies updated to latest (TypeScript 7, Vitest 5, Biome 2.6, @types/node 26); `tsup` replaced by `tsdown`
- Release workflow: Node 24, current GitHub Action majors, typecheck and test before publish

### Removed

- Photo sending via `{ raw: JSON.stringify({ photo, caption }) }`; use `attachments` instead. `raw` is now sent as plain text
- `ZaloAdapter#splitMessage` method (use the exported `splitMessage`)

## 0.1.0

### Initial release

- Zalo Bot Platform adapter for Chat SDK
- Support for text, image, and sticker messages
- Webhook verification with timing-safe secret comparison
- Auto-chunking for messages exceeding 2000-character limit
- Typing indicator support
- Buffered streaming (accumulates chunks, sends as single message)
