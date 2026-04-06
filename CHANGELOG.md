# chat-adapter-zalo

## 0.1.0

### Initial release

- Zalo Bot Platform adapter for Chat SDK
- Support for text, image, and sticker messages
- Webhook verification with timing-safe secret comparison
- Auto-chunking for messages exceeding 2000-character limit
- Typing indicator support
- Buffered streaming (accumulates chunks, sends as single message)
