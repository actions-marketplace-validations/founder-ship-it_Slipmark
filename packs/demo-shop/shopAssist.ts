/**
 * ShopAssist — a tiny e-commerce support reply composer used as the "product
 * under test" for the demo pack. This is intentionally NOT ReplyOS: it proves
 * the DriftGuard engine works on an unrelated domain with no engine changes.
 *
 * It contains ONE deliberately planted regression (see PLANTED_BUG) so the demo
 * can show DriftGuard catching and diagnosing a real behavioural drift.
 */

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface CatalogEntry {
  priceGBP?: number;
}
export type Catalog = Record<string, CatalogEntry>;

export const CATALOG: Catalog = {
  "blue mug": { priceGBP: 12 },
  "gift card": {}, // intentionally has NO price configured
};

/**
 * If true, the composer (incorrectly) anchors on the FIRST user intent instead
 * of the latest one — a classic stale-intent-carryover regression.
 * Flip to `false` to "fix" it and watch the lock turn green.
 */
export const PLANTED_BUG = true;

function classifyIntent(text: string): "track" | "return" | "price" | "unknown" {
  const t = text.toLowerCase();
  if (/\btrack|where.*order|delivery|shipped\b/.test(t)) return "track";
  if (/\breturn|refund|send.*back\b/.test(t)) return "return";
  if (/\bprice|how much|cost\b/.test(t)) return "price";
  return "unknown";
}

function namedItem(text: string): string | null {
  const t = text.toLowerCase();
  for (const item of Object.keys(CATALOG)) {
    if (t.includes(item)) return item;
  }
  return null;
}

export function composeReply(turns: Turn[], catalog: Catalog = CATALOG): string {
  const userTurns = turns.filter((t) => t.role === "user");
  const first = userTurns[0]?.text ?? "";
  const latest = userTurns[userTurns.length - 1]?.text ?? "";

  // The planted regression: topic is taken from `first` instead of `latest`.
  const topicSource = PLANTED_BUG ? first : latest;
  const intent = classifyIntent(topicSource);

  if (intent === "track") {
    return "I can help you track your order — could you share your order number so I can pull up the delivery status?";
  }
  if (intent === "return") {
    return "I can help with your return — returns are free within 30 days; would you like me to start the return process?";
  }
  if (intent === "price") {
    const item = namedItem(latest);
    if (item && typeof catalog[item]?.priceGBP === "number") {
      return `The ${item} is £${catalog[item]!.priceGBP}.`;
    }
    // Correct: no configured price → safe fallback, never invent a number.
    return `I don't have a price listed for that item right now — let me check with the team and get back to you.`;
  }
  return "Happy to help — could you tell me a little more about what you need?";
}
