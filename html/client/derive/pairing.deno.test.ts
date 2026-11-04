import { assertEquals } from "jsr:@std/assert@1";
import { pairingExpiry } from "./pairing.ts";

Deno.test("pairing expiry timeline changes at minute boundaries and ends expired", () => {
  const now = Date.parse("2026-11-04T20:00:00Z");
  const expiry = pairingExpiry("2026-11-04T20:07:00Z", now);
  assertEquals(expiry.steps[0], { label: "Expires in 7 min", delayMs: 0 });
  assertEquals(expiry.steps[1], { label: "Expires in 6 min", delayMs: 60_000 });
  assertEquals(expiry.steps.at(-1), { label: "Code expired", delayMs: 420_000 });
  assertEquals(pairingExpiry("2026-11-04T19:59:00Z", now).steps, [{ label: "Code expired", delayMs: 0 }]);
  assertEquals(pairingExpiry("unknown", now).steps[0].label, "Expiry not recorded");
});
