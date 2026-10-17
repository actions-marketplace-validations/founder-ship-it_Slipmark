/**
 * Demo pack: "ShopAssist" — an e-commerce support assistant.
 *
 * This pack carries ALL the domain knowledge. The Slipmark engine imports
 * nothing from here; it just receives this object. Swapping this for the ReplyOS
 * pack (or any other) is the entire extensibility story.
 */
import { definePack } from "../../src/index.js";
import type { Pack } from "../../src/types.js";
import { latestIntentWins } from "./locks/latestIntentWins.js";
import { noInventedPrice } from "./locks/noInventedPrice.js";

export const demoShopPack: Pack = definePack({
  id: "demo-shop",
  signatures: [
    {
      key: "stale_intent_carryover",
      label: "Stale intent carryover",
      description: "The reply continues to address an earlier topic after the user pivoted to a new intent.",
      assertionNames: ["focuses_on_latest_intent", "no_prior_intent_carryover"],
      patterns: [/latest\s+intent/i, /prior\s+(?:intent|topic)/i, /carry(?:over|forward)/i, /superseded/i],
    },
    {
      key: "ungrounded_price_invention",
      label: "Ungrounded price invention",
      description: "A numeric price was produced for an item that has no configured price.",
      assertionNames: ["no_numeric_price_invention", "contains_safe_price_fallback"],
      patterns: [/invent(?:ed)?\s+(?:a\s+)?(?:numeric\s+)?price/i, /fabricat\w*\s+(?:price|cost)/i, /unpriced/i],
    },
    {
      key: "competitor_leak",
      label: "Competitor mention leak",
      description: "The reply names a competitor or an unrelated product line.",
      assertionNames: ["no_competitor_mention"],
      patterns: [/competitor/i, /unrelated\s+product/i],
    },
  ],
  signatureToModules: {
    stale_intent_carryover: ["intent_resolution", "reply_composer"],
    ungrounded_price_invention: ["pricing_grounding", "reply_composer"],
    competitor_leak: ["reply_composer", "catalog_lookup"],
  },
  baseConstraints: [
    "Do not change the support assistant's tone or break existing channel flows",
    "Do not introduce or auto-fix unrelated areas of the codebase",
    "Do not change Slipmark lock logic to make a failing lock pass",
  ],
  scopeConstraints: {
    ai: [
      "Latest user intent must win over earlier topics in the composed reply",
      "Do not introduce numeric prices unless grounded in the configured catalogue",
    ],
  },
  scopeImpact: {
    ai: "Customers may receive replies that answer a superseded question or quote made-up prices — hurting trust and conversion.",
  },
  signatureGoals: {
    stale_intent_carryover: "Ensure the composer anchors on the latest user intent, not an earlier superseded one.",
    ungrounded_price_invention: "Suppress fabricated prices and route to a safe fallback when no price is configured.",
    competitor_leak: "Stop unrelated products / competitors from leaking into replies.",
  },
  signatureImpact: {
    stale_intent_carryover: "Users who change topic mid-chat get answered about the wrong thing — high abandonment risk.",
    ungrounded_price_invention: "Quoting unbacked prices is a commercial hazard.",
    competitor_leak: "Surfacing competitors erodes trust and brand.",
  },
  diffKeywords: ["intent", "compose", "reply", "price", "catalog", "fallback", "first", "latest"],
  systemMap: {
    modules: [
      {
        moduleKey: "intent_resolution",
        displayName: "Intent resolution",
        shortSummary: "Decides which user intent the reply should address.",
        commonFailureModes: ["anchors on the first intent instead of the latest", "misclassifies a pivot"],
        typicalDriftSignatures: ["stale_intent_carryover"],
      },
      {
        moduleKey: "reply_composer",
        displayName: "Reply composer",
        shortSummary: "Builds the final reply text from the resolved intent and catalogue data.",
        commonFailureModes: ["leaks unrelated content", "invents prices"],
        typicalDriftSignatures: ["ungrounded_price_invention", "competitor_leak"],
      },
      {
        moduleKey: "pricing_grounding",
        displayName: "Pricing grounding",
        shortSummary: "Ensures any quoted price is backed by the configured catalogue.",
        commonFailureModes: ["emits a number when no price is configured"],
        typicalDriftSignatures: ["ungrounded_price_invention"],
      },
    ],
  },
  locks: [latestIntentWins, noInventedPrice],
});
