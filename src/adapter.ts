import { timingSafeEqual } from "node:crypto";
import {
  AdapterError,
  AdapterRateLimitError,
  extractCard,
  extractFiles,
  extractPostableAttachments,
  ValidationError,
} from "@chat-adapter/shared";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  Author,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  RawMessage,
  StreamChunk,
  StreamOptions,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import { Message } from "chat";
import { ZaloFormatConverter, type ZaloRichText } from "./format-converter";
import type {
  ZaloAdapterConfig,
  ZaloApiResponse,
  ZaloChatType,
  ZaloGetMeResponse,
  ZaloInboundMessage,
  ZaloRawMessage,
  ZaloSendResponse,
  ZaloTextStyle,
  ZaloThreadId,
  ZaloWebhookResult,
} from "./types";

/** Maximum message length for Zalo Bot API */
const ZALO_MESSAGE_LIMIT = 2000;

const WHITESPACE = /\s/;

/** Maximum number of group chat IDs remembered for `isDM` lookups */
const GROUP_CACHE_LIMIT = 1000;

/**
 * Compute `[start, end)` ranges that fit within Zalo's 2000-character message
 * limit, breaking on paragraph boundaries when possible, then line
 * boundaries, and finally at the character limit as a last resort. Whitespace
 * around each break is excluded from the ranges.
 */
function splitRanges(text: string): Array<[number, number]> {
  if (text.length <= ZALO_MESSAGE_LIMIT) {
    return [[0, text.length]];
  }

  const ranges: Array<[number, number]> = [];
  let pos = 0;

  while (text.length - pos > ZALO_MESSAGE_LIMIT) {
    const slice = text.slice(pos, pos + ZALO_MESSAGE_LIMIT);

    // Try to break at a paragraph boundary
    let breakIndex = slice.lastIndexOf("\n\n");
    if (breakIndex === -1 || breakIndex < ZALO_MESSAGE_LIMIT / 2) {
      // Try a line boundary
      breakIndex = slice.lastIndexOf("\n");
    }
    if (breakIndex === -1 || breakIndex < ZALO_MESSAGE_LIMIT / 2) {
      // Hard break at the limit
      breakIndex = ZALO_MESSAGE_LIMIT;
    }

    let end = pos + breakIndex;
    while (end > pos && WHITESPACE.test(text[end - 1] as string)) {
      end--;
    }
    ranges.push([pos, end]);

    pos += breakIndex;
    while (pos < text.length && WHITESPACE.test(text[pos] as string)) {
      pos++;
    }
  }

  if (pos < text.length) {
    ranges.push([pos, text.length]);
  }

  return ranges;
}

/**
 * Split text into chunks that fit within Zalo's 2000-character message limit.
 */
export function splitMessage(text: string): string[] {
  return splitRanges(text).map(([start, end]) => text.slice(start, end));
}

/**
 * Split rich text into chunks, clipping and re-basing style runs per chunk.
 */
function splitRichText(rich: ZaloRichText): ZaloRichText[] {
  return splitRanges(rich.text).map(([start, end]) => {
    const styles: ZaloTextStyle[] = [];
    for (const run of rich.styles) {
      const from = Math.max(run.start, start);
      const to = Math.min(run.start + run.len, end);
      if (to > from) {
        styles.push({ start: from - start, len: to - from, st: run.st });
      }
    }
    return { text: rich.text.slice(start, end), styles };
  });
}

/**
 * Zalo adapter for chat SDK.
 *
 * Supports messaging via the Zalo Bot Platform API.
 * Handles both PRIVATE and GROUP chat types.
 *
 * @example
 * ```typescript
 * import { Chat } from "chat";
 * import { createZaloAdapter } from "chat-adapter-zalo";
 * import { MemoryState } from "@chat-adapter/state-memory";
 *
 * const chat = new Chat({
 *   userName: "my-bot",
 *   adapters: {
 *     zalo: createZaloAdapter(),
 *   },
 *   state: new MemoryState(),
 * });
 * ```
 */
export class ZaloAdapter implements Adapter<ZaloThreadId, ZaloRawMessage> {
  readonly name = "zalo";
  readonly lockScope = "channel" as const;
  readonly persistThreadHistory = true;
  readonly userName: string;

  private readonly botToken: string;
  private readonly webhookSecret: string;
  private logger: Logger;
  private readonly formatConverter = new ZaloFormatConverter();
  private readonly groupChats = new Set<string>();
  private chat: ChatInstance | null = null;
  private _botUserId: string | null = null;

  /** Bot user ID used for self-message detection */
  get botUserId(): string | undefined {
    return this._botUserId ?? undefined;
  }

  constructor(config: ZaloAdapterConfig) {
    this.botToken = config.botToken;
    this.webhookSecret = config.webhookSecret;
    this.logger = config.logger;
    this.userName = config.userName;
  }

  /**
   * Initialize the adapter and validate the bot token via getMe.
   */
  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger("zalo");

    const me = await this.apiRequest<ZaloGetMeResponse>("getMe");
    this._botUserId = me.id;
    this.logger.info("Zalo adapter initialized", {
      botId: me.id,
      accountName: me.account_name,
    });
  }

  /**
   * Handle incoming webhook from Zalo Bot Platform.
   *
   * Verifies the X-Bot-Api-Secret-Token header, parses the payload,
   * and dispatches messages to the Chat instance.
   */
  async handleWebhook(
    request: Request,
    options?: WebhookOptions,
  ): Promise<Response> {
    // Verify secret token
    const token = request.headers.get("x-bot-api-secret-token");
    if (!this.verifySecretToken(token)) {
      this.logger.warn("Zalo webhook: invalid secret token");
      return new Response("Unauthorized", { status: 401 });
    }

    const body = await request.text();
    this.logger.debug("Zalo webhook raw body", {
      body: body.substring(0, 500),
    });

    let payload: ZaloWebhookResult;
    try {
      payload = JSON.parse(body) as ZaloWebhookResult;
    } catch {
      this.logger.error("Zalo webhook invalid JSON", {
        bodyPreview: body.substring(0, 200),
      });
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!payload) {
      this.logger.debug("Zalo webhook: payload ok=false or missing result", {
        ok: false,
      });
      return new Response("OK", { status: 200 });
    }

    const { event_name, message } = payload;

    switch (event_name) {
      case "message.text.received":
      case "message.image.received":
      case "message.sticker.received":
      case "message.voice.received":
        if (message) {
          this.handleInboundMessage(message, options);
        }
        break;
      case "message.unsupported.received":
        this.logger.debug("Zalo webhook: unsupported message type, ignoring", {
          messageId: message?.message_id,
        });
        break;
      default:
        this.logger.debug("Zalo webhook: unknown event, ignoring", {
          event_name,
        });
    }

    return new Response("OK", { status: 200 });
  }

  /**
   * Handle an inbound message from a user.
   *
   * In GROUP chats the platform only delivers replies to the bot and
   * messages that mention it, so every group message counts as a mention.
   */
  private handleInboundMessage(
    inbound: ZaloInboundMessage,
    options?: WebhookOptions,
  ): void {
    if (!this.chat) {
      this.logger.warn("Chat instance not initialized, ignoring message");
      return;
    }

    this.rememberChatType(inbound.chat.id, inbound.chat.chat_type);

    const threadId = this.encodeThreadId({ chatId: inbound.chat.id });
    const raw: ZaloRawMessage = { message: inbound };
    const message = this.parseMessage(raw);
    if (inbound.chat.chat_type === "GROUP") {
      message.isMention = true;
    }
    this.chat.processMessage(this, threadId, message, options);
  }

  /**
   * Remember which chats are groups. Thread IDs don't encode the chat type,
   * so `isDM` relies on this (bounded, in-memory) record from inbound events.
   */
  private rememberChatType(chatId: string, chatType: ZaloChatType): void {
    if (chatType !== "GROUP") {
      this.groupChats.delete(chatId);
      return;
    }
    this.groupChats.delete(chatId);
    if (this.groupChats.size >= GROUP_CACHE_LIMIT) {
      const oldest = this.groupChats.values().next().value;
      if (oldest !== undefined) {
        this.groupChats.delete(oldest);
      }
    }
    this.groupChats.add(chatId);
  }

  /**
   * Verify the webhook secret token using timing-safe comparison.
   */
  private verifySecretToken(token: string | null): boolean {
    if (!token) {
      return false;
    }

    try {
      return timingSafeEqual(
        Buffer.from(token),
        Buffer.from(this.webhookSecret),
      );
    } catch {
      return false;
    }
  }

  /**
   * Parse platform message format to normalized format.
   */
  parseMessage(raw: ZaloRawMessage): Message<ZaloRawMessage> {
    const { message } = raw;

    // Extract text content based on message type
    let text: string;
    const attachments: Attachment[] = [];

    const photoUrl = message.photo_url ?? message.photo;

    if (message.text) {
      text = message.text;
    } else if (photoUrl) {
      text = message.caption ?? "[Image]";
      attachments.push({ type: "image", url: photoUrl });
    } else if (message.voice_url) {
      text = "[Voice]";
      attachments.push({
        type: "audio",
        url: message.voice_url,
        mimeType: "audio/aac",
      });
    } else if (message.sticker) {
      text = "[Sticker]";
      if (message.url) {
        attachments.push({ type: "image", url: message.url });
      }
    } else {
      text = "[Unsupported message]";
    }

    const threadId = this.encodeThreadId({ chatId: message.chat.id });
    const formatted: FormattedContent = this.formatConverter.toAst(text);

    const author: Author = {
      userId: message.from.id,
      userName: message.from.display_name,
      fullName: message.from.display_name,
      isBot: message.from.is_bot,
      isMe: message.from.id === this._botUserId,
    };

    return new Message<ZaloRawMessage>({
      id: message.message_id,
      threadId,
      text,
      formatted,
      raw,
      author,
      metadata: {
        dateSent: new Date(message.date),
        edited: false,
      },
      attachments,
    });
  }

  /**
   * Send a message to a Zalo chat.
   *
   * Image attachments (by URL) are sent with `sendPhoto`, audio attachments
   * (by `.aac` URL, 1-1 chats only) with `sendVoice`. Text is sent with
   * `sendMessage` and carries bold/italic/strikethrough/heading formatting via
   * `text_styles`. When a single image is posted with unformatted text that
   * fits the limit, the text becomes the photo caption.
   */
  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ZaloRawMessage>> {
    const { chatId } = this.decodeThreadId(threadId);

    if (extractCard(message)) {
      // Zalo doesn't support rich cards
      throw new AdapterError(
        "Zalo adapter does not support card messages. Please convert your card to text or image before sending.",
        "zalo",
      );
    }

    if (extractFiles(message).length > 0) {
      throw new ValidationError(
        "zalo",
        "Zalo does not support file uploads. Attach media by URL instead.",
      );
    }

    const attachments = extractPostableAttachments(message);
    for (const attachment of attachments) {
      if (!attachment.url || !["image", "audio"].includes(attachment.type)) {
        throw new ValidationError(
          "zalo",
          "Zalo only supports image and audio attachments referenced by url.",
        );
      }
    }
    const images = attachments.filter((a) => a.type === "image");
    const voices = attachments.filter((a) => a.type === "audio");

    const rich = this.formatConverter.renderPostableRich(message);
    const captionable =
      images.length === 1 &&
      rich.styles.length === 0 &&
      rich.text.length > 0 &&
      rich.text.length <= ZALO_MESSAGE_LIMIT;

    let result: RawMessage<ZaloRawMessage> | undefined;

    for (const image of images) {
      const caption = captionable ? rich.text : undefined;
      const photo = image.url as string;
      const response = await this.sendPhoto(chatId, photo, caption);
      result = this.buildRawMessage(threadId, chatId, response, {
        photo_url: photo,
        caption,
      });
    }

    for (const voice of voices) {
      const voiceUrl = voice.url as string;
      const response = await this.sendVoice(chatId, voiceUrl);
      result = this.buildRawMessage(threadId, chatId, response, {
        voice_url: voiceUrl,
      });
    }

    if (captionable || (rich.text.length === 0 && result)) {
      return result as RawMessage<ZaloRawMessage>;
    }
    return this.sendTextMessage(threadId, chatId, rich);
  }

  /**
   * Build the RawMessage describing a message this bot just sent.
   */
  private buildRawMessage(
    threadId: string,
    chatId: string,
    response: ZaloSendResponse,
    content: Partial<ZaloInboundMessage>,
  ): RawMessage<ZaloRawMessage> {
    return {
      id: response.message_id,
      threadId,
      raw: {
        message: {
          message_id: response.message_id,
          date: response.date,
          chat: {
            id: chatId,
            chat_type: this.groupChats.has(chatId) ? "GROUP" : "PRIVATE",
          },
          from: {
            id: this._botUserId ?? "",
            display_name: this.userName,
            is_bot: true,
          },
          ...content,
        },
      },
    };
  }

  /**
   * Send a text message, splitting into multiple messages if it exceeds
   * Zalo's 2000-character limit. Returns the last message sent.
   */
  private async sendTextMessage(
    threadId: string,
    chatId: string,
    rich: ZaloRichText,
  ): Promise<RawMessage<ZaloRawMessage>> {
    let result: RawMessage<ZaloRawMessage> | undefined;

    for (const chunk of splitRichText(rich)) {
      const response = await this.apiRequest<ZaloSendResponse>("sendMessage", {
        chat_id: chatId,
        text: chunk.text,
        ...(chunk.styles.length > 0 ? { text_styles: chunk.styles } : {}),
      });
      result = this.buildRawMessage(threadId, chatId, response, {
        text: chunk.text,
      });
    }

    return result as RawMessage<ZaloRawMessage>;
  }

  /**
   * Send a photo (by URL) to a Zalo chat.
   */
  async sendPhoto(
    chatId: string,
    photoUrl: string,
    caption?: string,
  ): Promise<ZaloSendResponse> {
    return this.apiRequest<ZaloSendResponse>("sendPhoto", {
      chat_id: chatId,
      photo: photoUrl,
      ...(caption ? { caption } : {}),
    });
  }

  /**
   * Send a sticker (ID from https://stickers.zaloapp.com/) to a Zalo chat.
   */
  async sendSticker(
    chatId: string,
    sticker: string,
  ): Promise<ZaloSendResponse> {
    return this.apiRequest<ZaloSendResponse>("sendSticker", {
      chat_id: chatId,
      sticker,
    });
  }

  /**
   * Send a voice message (`.aac` file URL, no caption). 1-1 chats only: the
   * API may report success for a group chat ID without delivering anything,
   * so known group chats are rejected up front.
   */
  async sendVoice(chatId: string, voiceUrl: string): Promise<ZaloSendResponse> {
    if (this.groupChats.has(chatId)) {
      throw new ValidationError(
        "zalo",
        "Zalo sendVoice does not support group chats.",
      );
    }
    return this.apiRequest<ZaloSendResponse>("sendVoice", {
      chat_id: chatId,
      voice_url: voiceUrl,
    });
  }

  /**
   * Edit a message. Not supported by Zalo Bot API.
   */
  async editMessage(
    _threadId: string,
    _messageId: string,
    _message: AdapterPostableMessage,
  ): Promise<RawMessage<ZaloRawMessage>> {
    throw new Error("Zalo does not support editing messages.");
  }

  /**
   * Delete a message. Not supported by Zalo Bot API.
   */
  async deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new Error("Zalo does not support deleting messages.");
  }

  /**
   * Add a reaction. Not supported by Zalo Bot API.
   */
  async addReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new Error("Zalo does not support reactions.");
  }

  /**
   * Remove a reaction. Not supported by Zalo Bot API.
   */
  async removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new Error("Zalo does not support reactions.");
  }

  /**
   * Start typing indicator via sendChatAction.
   */
  async startTyping(threadId: string, _status?: string): Promise<void> {
    const { chatId } = this.decodeThreadId(threadId);
    try {
      await this.apiRequest("sendChatAction", {
        chat_id: chatId,
        action: "typing",
      });
    } catch (error) {
      // Typing is best-effort — don't propagate errors
      this.logger.debug("Zalo startTyping failed (non-fatal)", { error });
    }
  }

  /**
   * Stream a message by buffering all chunks and sending as a single message.
   * Zalo doesn't support message editing.
   */
  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    _options?: StreamOptions,
  ): Promise<RawMessage<ZaloRawMessage>> {
    let accumulated = "";
    for await (const chunk of textStream) {
      if (typeof chunk === "string") {
        accumulated += chunk;
      } else if (chunk.type === "markdown_text") {
        accumulated += chunk.text;
      }
    }
    return this.postMessage(threadId, { markdown: accumulated });
  }

  /**
   * Fetch messages. Not supported by Zalo Bot API.
   */
  async fetchMessages(
    _threadId: string,
    _options?: FetchOptions,
  ): Promise<FetchResult<ZaloRawMessage>> {
    this.logger.debug(
      "fetchMessages not supported on Zalo - message history is not available via Bot API",
    );
    return { messages: [] };
  }

  /**
   * Fetch thread info from decoded thread ID.
   */
  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { chatId } = this.decodeThreadId(threadId);

    return {
      id: threadId,
      channelId: threadId,
      channelName: `Zalo: ${chatId}`,
      isDM: !this.groupChats.has(chatId),
      metadata: { chatId },
    };
  }

  /**
   * Encode a Zalo thread ID.
   *
   * Format: zalo:{chatId}
   */
  encodeThreadId(platformData: ZaloThreadId): string {
    return `zalo:${platformData.chatId}`;
  }

  /**
   * Decode a Zalo thread ID.
   *
   * Format: zalo:{chatId}
   */
  decodeThreadId(threadId: string): ZaloThreadId {
    if (!threadId.startsWith("zalo:")) {
      throw new ValidationError("zalo", `Invalid Zalo thread ID: ${threadId}`);
    }

    const chatId = threadId.slice(5);
    if (!chatId) {
      throw new ValidationError(
        "zalo",
        `Invalid Zalo thread ID format: ${threadId}`,
      );
    }

    return { chatId };
  }

  /**
   * Derive channel ID from a Zalo thread ID.
   * Zalo has no threading — channel === thread.
   */
  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  /**
   * Conversations are DMs unless an inbound event marked the chat as a GROUP.
   * Thread IDs don't encode the chat type, so this is only known for chats
   * seen by this process.
   */
  isDM(threadId: string): boolean {
    return !this.groupChats.has(this.decodeThreadId(threadId).chatId);
  }

  /**
   * Open a DM with a user. Returns the thread ID for the conversation.
   */
  async openDM(userId: string): Promise<string> {
    return this.encodeThreadId({ chatId: userId });
  }

  /**
   * Render formatted content to plain text.
   */
  renderFormatted(content: FormattedContent): string {
    return this.formatConverter.fromAst(content);
  }

  // =============================================================================
  // Private helpers
  // =============================================================================

  /**
   * Make an authenticated request to the Zalo Bot API.
   * Note: bot token is embedded in the URL path — never log it.
   */
  private async apiRequest<T = unknown>(
    method: string,
    body?: unknown,
  ): Promise<T> {
    const url = `https://bot-api.zaloplatforms.com/bot${this.botToken}/${method}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (response.status === 429) {
      this.logger.error("Zalo API rate limited", { method });
      throw new AdapterRateLimitError("zalo");
    }

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error("Zalo API HTTP error", {
        status: response.status,
        body: errorBody,
        method,
      });
      throw new AdapterError(
        `Zalo API error: ${response.status} ${errorBody}`,
        "zalo",
      );
    }

    const data = (await response.json()) as ZaloApiResponse<T>;

    if (!data.ok) {
      this.logger.error("Zalo API returned ok=false", {
        error_code: data.error_code,
        description: data.description,
        method,
      });

      if (data.error_code === 429) {
        throw new AdapterRateLimitError("zalo");
      }

      throw new AdapterError(
        `Zalo API error (${data.error_code ?? "unknown"}): ${data.description ?? "unknown error"}`,
        "zalo",
      );
    }

    return data.result as T;
  }
}
