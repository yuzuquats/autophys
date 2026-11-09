import { assert, assertFalse } from "jsr:@std/assert@1";
import { isLonaHosted } from "./hosted-badge.ts";

Deno.test("the hackathon pill shows only on Lona's hosted Autophys sites", () => {
  for (const host of ["autophys.lona.so", "dev--autophys.lona.so", "AUTOPHYS.lona.so", "autophys.lona.so."]) {
    assert(isLonaHosted(host), host);
  }
  for (const host of ["localhost", "127.0.0.1", "lona.so", "autophys.lona.so.evil.example", "x.autophys.lona.so", "evilautophys.lona.so", ""]) {
    assertFalse(isLonaHosted(host), host);
  }
});
