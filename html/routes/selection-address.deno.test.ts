import { assertEquals } from "jsr:@std/assert@1";
import { selectionAddress } from "./selection-address.ts";
Deno.test("legacy selection URLs preserve slashes, measurement ids, encoded hashes and queries", () => {
  for (const [search, hash, expected] of [
    ["", "#bench-b/fit-1/residuals", "bench-b/fit-1/residuals"],
    ["", "#bench-b%2Fdata%2Ffree_response%401", "bench-b/data/free_response@1"],
    ["", "#/bench-b/sens", "bench-b/sens"],
    ["?selection=bench-b%2Ftruth", "", "bench-b/truth"],
    ["?select=bench-b%2Fvalidate", "", "bench-b/validate"],
    ["?selection=bench-b", "#bench-a", "bench-a"],
    ["", "#%broken", null], ["?source=fixtures", "", null],
  ]) assertEquals(selectionAddress(search!, hash!), expected);
});
