import { ValidationError } from "@chat-adapter/shared";
import type { Logger } from "chat";
import { ConsoleLogger } from "chat";
import { ZaloAdapter } from "./adapter";

/**
 * Factory function to create a Zalo adapter.
 *
 * @example
 * ```typescript
 * const adapter = createZaloAdapter({
 *   botToken: process.env.ZALO_BOT_TOKEN!,
 *   webhookSecret: process.env.ZALO_WEBHOOK_SECRET!,
 * });
 * ```
 */
export function createZaloAdapter(config?: {
  botToken?: string;
  logger?: Logger;
  userName?: string;
  webhookSecret?: string;
}): ZaloAdapter {
  const logger = config?.logger ?? new ConsoleLogger("info").child("zalo");

  const botToken = config?.botToken ?? process.env.ZALO_BOT_TOKEN;
  if (!botToken) {
    throw new ValidationError(
      "zalo",
      "botToken is required. Set ZALO_BOT_TOKEN or provide it in config.",
    );
  }

  const webhookSecret =
    config?.webhookSecret ?? process.env.ZALO_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new ValidationError(
      "zalo",
      "webhookSecret is required. Set ZALO_WEBHOOK_SECRET or provide it in config.",
    );
  }

  const userName =
    config?.userName ?? process.env.ZALO_BOT_USERNAME ?? "zalo-bot";

  return new ZaloAdapter({ botToken, webhookSecret, userName, logger });
}
