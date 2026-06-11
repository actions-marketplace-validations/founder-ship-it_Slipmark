/**
 * Lock: after a user pivots topic, the reply must address the LATEST intent.
 * This lock will FAIL while shopAssist's PLANTED_BUG is true.
 */
import type { LockDefinition, LockResult } from "../../../src/types.js";
import { composeReply, PLANTED_BUG, type Turn } from "../shopAssist.js";

const PIVOT_FIXTURE: Turn[] = [
  { role: "user", text: "I want to return an item I bought" },
  { role: "assistant", text: "Sure, I can help with that." },
  { role: "user", text: "actually never mind — can you track my order instead?" },
];

export const latestIntentWins: LockDefinition = {
  key: "shop.latest_intent_wins",
  name: "Latest intent wins after a topic pivot",
  scope: "ai",
  domains: ["support", "conversation"],
  invariants: [
    "When the user pivots topic, the reply addresses the most recent intent.",
    "The reply does not continue answering a superseded earlier intent.",
  ],
  likelyFiles: ["packs/demo-shop/shopAssist.ts"],
  likelyModules: ["intent_resolution", "reply_composer"],
  failureSignatures: ["stale_intent_carryover"],
  // The specific symbols this invariant depends on — a change to one of these is
  // earned causal evidence, not a guess.
  watchedSymbols: ["composeReply", "classifyIntent"],
  run(): LockResult {
    const reply = composeReply(PIVOT_FIXTURE).toLowerCase();
    const addressesTracking = /track|delivery|order number/.test(reply);
    const carriesOldReturnIntent = /return|refund/.test(reply);

    // A good lock instruments itself: record what mechanism actually produced the
    // behavior, so diagnosis is backed by observation rather than pattern-matching.
    const trace: LockResult["trace"] = {
      modules: ["intent_resolution", "reply_composer"],
      symbols: ["composeReply", "classifyIntent"],
      observations: {
        intentSourceUsed: PLANTED_BUG ? "first" : "latest",
        expectedIntentSource: "latest",
        addressesLatestIntent: addressesTracking,
      },
    };

    const failed: LockResult["failedAssertions"] = [];
    if (!addressesTracking) {
      failed.push({
        name: "focuses_on_latest_intent",
        reason: "Reply does not address the latest intent (order tracking).",
      });
    }
    if (carriesOldReturnIntent) {
      failed.push({
        name: "no_prior_intent_carryover",
        reason: "Reply still discusses the previous 'return' intent after the user pivoted to tracking.",
      });
    }

    if (failed.length === 0) {
      return { status: "pass", message: "Reply correctly addresses the latest intent.", failedAssertions: [], trace };
    }
    return {
      status: "drift",
      message: "Reply carried a stale earlier intent instead of the latest one (latest intent did not win).",
      failedAssertions: failed,
      trace,
    };
  },
};
