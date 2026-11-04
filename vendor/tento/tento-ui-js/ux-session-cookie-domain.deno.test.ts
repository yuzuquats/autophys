import { assertEquals } from "jsr:@std/assert";
import { uxSessionCookieDomain } from "./ux-session-cookie-domain.ts";

Deno.test("UX sessions keep Lona subdomain continuity and use host-only cookies elsewhere", () => {
  for (const hostname of ["lona.so", "calendar.lona.so", "rc--ui.lona.so"]) {
    assertEquals(uxSessionCookieDomain(hostname), ".lona.so");
  }
  for (const hostname of ["127.0.0.1", "localhost", "brand.example", "lona.so.other.example", "notlona.so"]) {
    assertEquals(uxSessionCookieDomain(hostname), "");
  }
});
