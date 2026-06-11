/**
 * Lock: never invent a numeric price for an item with no configured price.
 * This lock PASSES (shopAssist handles missing prices correctly) — included to
 * show a mixed run (some green, some red), which is the realistic case.
 */
import type { LockDefinition, LockResult } from "../../../src/types.js";
import { composeReply, type Turn } from "../shopAssist.js";

const UNPRICED_FIXTURE: Turn[] = [{ role: "user", text: "how much is the gift card?" }];

export const noInventedPrice: LockDefinition = {
  key: "shop.no_invented_price",
  name: "No invented price for unpriced items",
  scope: "ai",
  domains: ["support", "pricing"],
  invariants: [
    "If an item has no configured price, the reply must not contain a fabricated numeric price.",
    "The reply offers a safe fallback instead of a made-up number.",
  ],
  likelyFiles: ["packs/demo-shop/shopAssist.ts"],
  likelyModules: ["pricing_grounding", "reply_composer"],
  failureSignatures: ["ungrounded_price_invention"],
  run(): LockResult {
    const reply = composeReply(UNPRICED_FIXTURE);
    const hasNumericPrice = /£\s?\d|\b\d+(?:\.\d{2})?\s?(?:gbp|pounds?)\b/i.test(reply);
    const hasFallback = /don'?t have a price|check with the team|get back to you/i.test(reply);

    const failed: LockResult["failedAssertions"] = [];
    if (hasNumericPrice) {
      failed.push({ name: "no_numeric_price_invention", reason: "Reply invented a numeric price for an unpriced item." });
    }
    if (!hasFallback) {
      failed.push({ name: "contains_safe_price_fallback", reason: "Reply lacks a safe fallback for the missing price." });
    }

    if (failed.length === 0) {
      return { status: "pass", message: "No price invented; safe fallback present.", failedAssertions: [] };
    }
    return { status: "drift", message: "Unpriced item handling drifted.", failedAssertions: failed };
  },
};
