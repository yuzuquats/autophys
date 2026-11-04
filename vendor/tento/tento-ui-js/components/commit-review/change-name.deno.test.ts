import { assertEquals } from "jsr:@std/assert";

import {
  formatName,
  handleToDisplay,
  handleToUrl,
  isHandle,
  type Name,
  nameOfChange,
  parseName,
  sameHandle,
} from "./change-name.ts";

// The contract in one line: a URL carries the bare lowercase handle, every
// spelling parses back to the same name, and nothing else in the selector
// grammar is mistaken for one.

Deno.test("a URL carries the bare lowercase form", () => {
  assertEquals(handleToUrl("L-142"), "l142");
  assertEquals(handleToUrl("D-1234"), "d1234");
});

Deno.test("every spelling is one name", () => {
  for (const written of ["L-142", "l142", "l-142", "L142"]) {
    assertEquals(isHandle(written), true, written);
    assertEquals(sameHandle("L-142", written), true, written);
  }
  // Different numbers, and different halves, are different names.
  assertEquals(sameHandle("L-142", "l143"), false);
  assertEquals(sameHandle("L-142", "d142"), false);
});

Deno.test("a null half never matches — an unnumbered draft is not every handle", () => {
  assertEquals(sameHandle(null, "l142"), false);
  assertEquals(sameHandle("L-142", null), false);
  assertEquals(sameHandle(undefined, undefined), false);
});

Deno.test("the rest of the selector grammar is not a handle", () => {
  // Every other selector shape, plus the words most likely to be mistaken.
  for (const other of [
    "unstaged",
    "draft:2eee5df30",
    "public:9f31c02ab",
    "project:commit-review-d-numbers",
    "foreign:tento:abc123",
    "queue:set-1",
    "I8954615ae35faef0",
    "landed",
    "local",
    "mono",
    "d",
    "l",
    "l0",
    "l-0",
    "l12a",
    "",
  ]) {
    assertEquals(isHandle(other), false, other);
  }
});

Deno.test("round trip: display -> url -> back to the same display form", () => {
  for (const display of ["L-1", "L-148", "D-1435", "D-6120"]) {
    const url = handleToUrl(display);
    assertEquals(isHandle(url), true, url);
    assertEquals(sameHandle(display, url), true, `${display} vs ${url}`);
    // The tab title reads a handle back out of the URL, so the inverse has to
    // land on the canonical spelling — not merely on an equal one.
    assertEquals(handleToDisplay(url), display);
  }
  // Every accepted spelling canonicalizes, and a non-handle is left alone
  // rather than being reshaped into something that looks like one.
  for (const written of ["l142", "l-142", "L142", "L-142"]) {
    assertEquals(handleToDisplay(written), "L-142", written);
  }
  for (const other of ["draft:2eee5df30", "I8954615ae35faef0", "landed", ""]) {
    assertEquals(handleToDisplay(other), other, other);
  }
});

// --- the Name union -------------------------------------------------------
// `parseName` is what lets the router try `isRepo` first and fall through
// cleanly, so the negative cases below are load-bearing, not decoration.

Deno.test("every name round trips through its URL spelling", () => {
  const corpus: Name[] = [
    { kind: "handle", half: "l", num: 142 },
    { kind: "handle", half: "d", num: 1234 },
    { kind: "cid", cid: "I8954615abcdef01" },
    { kind: "sha", sha: "2eee5df30" },
    { kind: "unstaged" },
    { kind: "queue", id: "set-1" },
  ];
  for (const name of corpus) {
    assertEquals(parseName(formatName(name)), name, formatName(name));
  }
});

Deno.test("a repo key is never mistaken for a name", () => {
  // The ambiguity rule leans on this: segment 2 is tried as a repo first, but
  // a repo that DID parse as a name would make the grammar undecidable.
  for (const repo of ["mono", "tento", "agent-state", "lona", "tsh"]) {
    assertEquals(parseName(repo), null, repo);
  }
});

Deno.test("nothing else in the grammar parses as a name", () => {
  for (const seg of ["", "landed", "draft", "queue:", "sha:", "sha:zzzz", "l0", "l-0", "d", "I"]) {
    assertEquals(parseName(seg), null, JSON.stringify(seg));
  }
});

Deno.test("D beats L beats the cid beats the sha", () => {
  const sha = "2eee5df30";
  assertEquals(nameOfChange({ d_global: "D-1234", d_handle: "L-142", change_id: "Iabc12345", sha }), {
    kind: "handle",
    half: "d",
    num: 1234,
  });
  assertEquals(nameOfChange({ d_global: null, d_handle: "L-142", change_id: "Iabc12345", sha }), {
    kind: "handle",
    half: "l",
    num: 142,
  });
  assertEquals(nameOfChange({ d_global: null, d_handle: null, change_id: "Iabc12345", sha }), {
    kind: "cid",
    cid: "Iabc12345",
  });
  // No Change-Id means no handle can ever exist, so the snapshot is the floor.
  assertEquals(nameOfChange({ d_global: null, d_handle: null, change_id: "", sha }), {
    kind: "sha",
    sha,
  });
});
