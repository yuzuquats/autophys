import { assertEquals } from "jsr:@std/assert";
import { join } from "jsr:@std/path";

import { sourceShortHead } from "./build-stamp.deno.ts";

const decoder = new TextDecoder("utf-8");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(`git ${args.join(" ")}: ${decoder.decode(out.stderr)}`);
  return decoder.decode(out.stdout).trim();
}

/** A checkout whose `/scratch` is ignored, like the workspace the RC was cut
 * in, with a tracked `build-stamp.ts`. */
async function checkout(): Promise<{ root: string; stamp: string; head: string }> {
  const root = await Deno.makeTempDir({ prefix: "build-stamp-" });
  await git(root, "init", "-q");
  await Deno.writeTextFile(join(root, ".gitignore"), "/scratch\n");
  await Deno.mkdir(join(root, "app"));
  const stamp = join(root, "app", "build-stamp.ts");
  await Deno.writeTextFile(stamp, 'export const BUILD_STAMP = "dev";\n');
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "fixture");
  return { root, stamp, head: await git(root, "rev-parse", "--short", "HEAD") };
}

Deno.test("a tracked build-stamp.ts is stamped with its own HEAD", async () => {
  const { root, stamp, head } = await checkout();
  try {
    assertEquals(await sourceShortHead(stamp, undefined), head);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an archive extracted inside another checkout is not stamped with its HEAD", async () => {
  const { root } = await checkout();
  try {
    const app = join(root, "scratch", "src-archive", "app");
    await Deno.mkdir(app, { recursive: true });
    const stamp = join(app, "build-stamp.ts");
    await Deno.writeTextFile(stamp, 'export const BUILD_STAMP = "dev";\n');
    assertEquals(await sourceShortHead(stamp, undefined), "nogit");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a build outside any checkout has no hash", async () => {
  const dir = await Deno.makeTempDir({ prefix: "build-stamp-" });
  try {
    const stamp = join(dir, "build-stamp.ts");
    await Deno.writeTextFile(stamp, 'export const BUILD_STAMP = "dev";\n');
    assertEquals(await sourceShortHead(stamp, undefined), "nogit");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the packager names the archived commit, and a malformed one is refused", async () => {
  const { root, stamp, head } = await checkout();
  try {
    assertEquals(await sourceShortHead(stamp, "faba1e64\n"), "faba1e64");
    const full = "faba1e6463f5b1b42c1e3b9e36f289b52c906145";
    assertEquals(await sourceShortHead(stamp, full), full);
    assertEquals(await sourceShortHead(stamp, "  "), head);
    for (const value of ["e8bb", "E8BBB29", 'e8bbb29";alert(1);"', "a".repeat(41)]) {
      assertEquals(await sourceShortHead(stamp, value), "nogit", value);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
