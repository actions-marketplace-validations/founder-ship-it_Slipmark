#!/usr/bin/env node
// Thin target script for the declarative demo: reads {"turns":[...]} as JSON on
// stdin and prints the assistant reply on stdout. This stands in for "your AI
// system" — DriftGuard does not care what language it is, only its output.
//
// It carries the same planted regression (anchors on the FIRST user intent) so
// the declarative pack has something to catch.
let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  let turns = [];
  try {
    turns = JSON.parse(data || "{}").turns || [];
  } catch {
    /* ignore */
  }
  const userTurns = turns.filter((t) => t && t.role === "user");
  const first = (userTurns[0]?.text ?? "").toLowerCase();
  const latest = (userTurns[userTurns.length - 1]?.text ?? "").toLowerCase();

  const PLANTED_BUG = true; // flip to false to "fix" it and watch the lock turn green
  const src = PLANTED_BUG ? first : latest;

  let reply;
  if (/track|where.*order|delivery|shipped/.test(src)) {
    reply = "I can help you track your order — please share your order number for the delivery status.";
  } else if (/return|refund|send.*back/.test(src)) {
    reply = "I can help with your return — returns are free within 30 days; want me to start it?";
  } else {
    reply = "Happy to help — could you tell me a little more about what you need?";
  }
  process.stdout.write(reply);
});
