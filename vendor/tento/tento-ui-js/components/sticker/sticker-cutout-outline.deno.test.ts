import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert";
import { PixelImage } from "@tento-core/pixel-image";

import { StickerArtCatalog } from "./sticker-art-catalog.ts";
import { StickerCutoutOutline } from "./sticker-cutout-outline.ts";
import { MockStickerPixelArtAsset } from "./sticker-pixel-art-asset.mock.ts";

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lzKBrQAAAABJRU5ErkJggg==";
const STICKER_STATIC_PREFIX = "/img/stickers/";
const STICKER_FILE_PREFIX =
  "lona/so.lona.static/html/static.routes/img/stickers/";
const STICKER_REGISTRY_FILE =
  "lona/so.lona.static/html/static.routes/img/stickers/registry.json";
const PNG_STATIC_PREFIX = "/img/stickers/pixel/lona-pixel-town/";
const PNG_FILE_PREFIX =
  "lona/so.lona.static/html/static.routes/img/stickers/pixel/lona-pixel-town/";

type ContourPoint = StickerCutoutOutline.Point;
type ContourSegment = { start: ContourPoint; end: ContourPoint };
type ContourModule = {
  samePoint(a: ContourPoint, b: ContourPoint): boolean;
  connectSegmentsToLoops(segments: ContourSegment[]): ContourPoint[][];
  StickerCutoutOutline: typeof StickerCutoutOutline;
};
let contourPair: Option<Promise<{ baseline: ContourModule; candidate: ContourModule }>>;

function contourImplementations(): Promise<{ baseline: ContourModule; candidate: ContourModule }> {
  // Execute the actual private functions without adding a production export.
  // The reference changes only the comparator to its original string-key form.
  return contourPair ??= (async () => {
    const source = await Deno.readTextFile(new URL("./sticker-cutout-outline.ts", import.meta.url));
    const pattern = /function samePoint\(a: Point, b: Point\): boolean \{[\s\S]*?\n\}/;
    assert(pattern.test(source));
    const baseline = source.replace(pattern,
      "function samePoint(a: Point, b: Point): boolean { return pointKey(a) === pointKey(b); }");
    const expose = "\nexport { samePoint, connectSegmentsToLoops };\n";
    const load = async (text: string): Promise<ContourModule> =>
      await import("data:application/typescript," + encodeURIComponent(text + expose));
    return { baseline: await load(baseline), candidate: await load(source) };
  })();
}

Deno.test("contour comparison retains exact three-decimal point equivalence", async () => {
  const { baseline, candidate } = await contourImplementations();
  const values = [-Infinity, -1e21, -1.0005, -1, -0.0005, -0.0004999999,
    -0.0000001, -0, 0, 0.0000001, 0.0004999999, 0.0005, 0.9995, 1, 1.0005,
    1e21, Infinity, NaN];
  const points = values.flatMap((x) => values.map((y) => ({ x, y })));
  for (const a of points) {
    for (const b of points) assertEquals(candidate.samePoint(a, b), baseline.samePoint(a, b));
  }
});

Deno.test("contour comparison avoids reading y when rounded x already differs", async () => {
  const { candidate } = await contourImplementations();
  let yReads = 0;
  const a = { x: 1, get y(): number { yReads++; return 4; } };
  const b = { x: 2, get y(): number { yReads++; return 4; } };
  assertEquals(candidate.samePoint(a, b), false);
  assertEquals(yReads, 0);
});

Deno.test("contour comparison preserves ordered loops and generated cutout bytes", async () => {
  const { baseline, candidate } = await contourImplementations();
  const segments: ContourSegment[] = [
    { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } },
    { start: { x: 1.0004, y: 0.0004 }, end: { x: 1, y: 1 } },
    { start: { x: 0, y: 1 }, end: { x: 1.0004, y: 1.0004 } },
    { start: { x: 0.0004, y: 1.0004 }, end: { x: 0, y: 0 } },
    { start: { x: -1, y: -1 }, end: { x: -2, y: -1 } },
    { start: { x: -2, y: -1 }, end: { x: -2, y: -2 } },
    { start: { x: -2, y: -2 }, end: { x: -1, y: -1 } },
  ];
  for (let rotation = 0; rotation < segments.length; rotation++) {
    const reordered = [...segments.slice(rotation), ...segments.slice(0, rotation)];
    assertEquals(candidate.connectSegmentsToLoops(reordered), baseline.connectSegmentsToLoops(reordered));
  }
  const data = new Uint8Array(12 * 12 * 4);
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 12; x++) {
      const i = (y * 12 + x) * 4;
      data.set([x * 20, y * 20, 120, (x > 1 && x < 10 && y > 1 && y < 10 && !(x > 4 && x < 7 && y > 4 && y < 7)) ? 255 : 0], i);
    }
  }
  const image = { width: 12, height: 12, data };
  for (const technique of ["catmull-rom", "chaikin", "chaikin-cubic"] as const) {
    const options = { id: "contour-equivalence", rasterScale: 2,
      style: { technique, cutoutWidthPx: 1.3, smoothingPx: 0.75, roundPx: 1.2 } };
    assertEquals(candidate.StickerCutoutOutline.generateSvgFromRgbaImage(image, options),
      baseline.StickerCutoutOutline.generateSvgFromRgbaImage(image, options));
  }
});

MockStickerPixelArtAsset.configureForTests(loadCatalogText, loadPngBytes);

Deno.test("PixelImage decodes owned RGBA PNG bytes into exact pixels", async () => {
  const bytes = await Deno.readFile(`${PNG_FILE_PREFIX}wildflowers.png`);
  const metadata = PixelImage.parsePngMetadata(bytes);
  const image = await PixelImage.decodePng(bytes);

  assertEquals(
    metadata.width,
    MockStickerPixelArtAsset.PIXEL_ART_SOURCE_WIDTH_PX,
  );
  assertEquals(
    metadata.height,
    MockStickerPixelArtAsset.PIXEL_ART_SOURCE_HEIGHT_PX,
  );
  assertEquals(metadata.bitDepth, 8);
  assertEquals(metadata.colorType, 6);
  assertEquals(metadata.interlaceMethod, 0);
  assertEquals(
    image.width,
    MockStickerPixelArtAsset.PIXEL_ART_SOURCE_WIDTH_PX,
  );
  assertEquals(
    image.height,
    MockStickerPixelArtAsset.PIXEL_ART_SOURCE_HEIGHT_PX,
  );
  assertEquals(
    image.data.length,
    MockStickerPixelArtAsset.PIXEL_ART_SOURCE_WIDTH_PX *
      MockStickerPixelArtAsset.PIXEL_ART_SOURCE_HEIGHT_PX *
      4,
  );
  assert(hasAlpha(image, 0));
  assert(hasAlpha(image, 255));
});

Deno.test("PixelImage integer-scales every source pixel into equal blocks", async () => {
  const source: PixelImage.RgbaImage = {
    width: 2,
    height: 2,
    data: new Uint8Array([
      255,
      0,
      0,
      255,
      0,
      255,
      0,
      255,
      0,
      0,
      0,
      0,
      0,
      0,
      255,
      255,
    ]),
  };
  const image = PixelImage.scaleNearest(source, 3);

  assertEquals(image.width, 6);
  assertEquals(image.height, 6);
  assertPixel(image, 0, 0, [255, 0, 0, 255]);
  assertPixel(image, 2, 2, [255, 0, 0, 255]);
  assertPixel(image, 3, 0, [0, 255, 0, 255]);
  assertPixel(image, 0, 3, [0, 0, 0, 0]);
  assertPixel(image, 5, 5, [0, 0, 255, 255]);

  const encoded = PixelImage.encodePng(image);
  const encodedMetadata = PixelImage.parsePngMetadata(encoded);
  const decoded = await PixelImage.decodePng(encoded);
  assertEquals(encodedMetadata.width, 6);
  assertEquals(encodedMetadata.height, 6);
  assertEquals([...decoded.data], [...image.data]);

  const compressed = await PixelImage.encodePngCompressed(image);
  const compressedMetadata = PixelImage.parsePngMetadata(compressed);
  const compressedDecoded = await PixelImage.decodePng(compressed);
  assertEquals(compressedMetadata.width, 6);
  assertEquals(compressedMetadata.height, 6);
  assertEquals([...compressedDecoded.data], [...image.data]);
});

Deno.test("PixelImage rejects invalid RGBA buffers and zero scales", () => {
  assertThrows(
    () =>
      PixelImage.scaleNearest(
        { width: 1, height: 1, data: new Uint8Array(3) },
        1,
      ),
    Error,
    "data length",
  );
  assertThrows(
    () =>
      PixelImage.scaleNearest(
        { width: 1, height: 1, data: new Uint8Array(4) },
        0,
      ),
    Error,
    "positive integer",
  );
});

Deno.test("sticker cutout parses PNG metadata from a data URL", () => {
  const bytes = StickerCutoutOutline.pngDataUrlToBytes(ONE_PIXEL_PNG);
  const metadata = StickerCutoutOutline.parsePngMetadata(bytes);

  assertEquals(metadata.width, 1);
  assertEquals(metadata.height, 1);
  assertEquals(metadata.bitDepth, 8);
  assertEquals(metadata.colorType, 6);
  assertEquals(metadata.hasTransparency, true);
});

Deno.test("sticker cutout emits a vector SVG background from final scaled PNG alpha", async () => {
  const bytes = StickerCutoutOutline.pngDataUrlToBytes(ONE_PIXEL_PNG);
  const result = await StickerCutoutOutline.generateSvgFromPngBytes(bytes, {
    id: "unit-test",
    rasterScale: 4,
    style: {
      paddingPx: 8,
      cutoutWidthPx: 2,
      roundPx: 1,
      smoothingPx: 1,
      fill: "#ffffff",
      shadow: {
        dxPx: 0,
        dyPx: 0,
        blurPx: 0,
        color: "#000000",
        opacity: 0.25,
      },
    },
  });

  assertEquals(result.metadata.width, 1);
  assertEquals(result.metadata.height, 1);
  assertEquals(result.rasterScale, 4);
  assertEquals(result.scale, 4);
  assertEquals(result.cutoutWidthPx, 2);
  assertEquals(result.smoothingPx, 1);
  assertEquals(result.technique, "chaikin-cubic");
  assertEquals(result.alphaThreshold, 64);
  assertEquals(result.edgeBleedPx, 0.7);
  assertEquals(result.artworkWidth, 4);
  assertEquals(result.artworkHeight, 4);
  const rasterMetadata = StickerCutoutOutline.parsePngMetadata(
    StickerCutoutOutline.pngDataUrlToBytes(result.pngDataUrl),
  );
  assertEquals(rasterMetadata.width, 4);
  assertEquals(rasterMetadata.height, 4);
  assertEquals(result.artworkOffsetX, 8);
  assertEquals(result.artworkOffsetY, 8);
  assertEquals(result.width, 20);
  assertEquals(result.height, 20);
  assertStringIncludes(result.svgDataUrl, "data:image/svg+xml");
  assertStringIncludes(result.svgText, "<path");
  assertStringIncludes(result.pathData, "C ");
  assertStringIncludes(result.svgText, 'fill="#ffffff"');
  assert(!result.svgText.includes("<filter"));
  assert(!result.svgText.includes("feDropShadow"));
  assert(!result.svgText.includes("<image"));
  assert(!result.svgText.includes("data:image/png;base64,"));
});

Deno.test("sticker cutout smooths an owned PNG pixel-art fixture into cubic vector paths", async () => {
  const asset = await requiredAsset("map-marker");
  const image = await imageFromAsset(asset);
  const result = StickerCutoutOutline.generateSvgFromRgbaImage(image, {
    id: "fixture-note",
    rasterScale: asset.displayScale,
    style: {
      fill: "#ffffff",
      cutoutWidthPx: 8,
      roundPx: 5,
      smoothingPx: 4,
      shadow: {
        dxPx: 0,
        dyPx: 4,
        blurPx: 3,
        color: "#000000",
        opacity: 0.28,
      },
    },
  });

  assertEquals(result.metadata.width, asset.intrinsicWidth);
  assertEquals(result.metadata.height, asset.intrinsicHeight);
  assertEquals(result.rasterScale, asset.displayScale);
  assertEquals(result.artworkWidth, asset.rasterWidth);
  assertEquals(result.artworkHeight, asset.rasterHeight);
  assert(result.width > result.artworkWidth);
  assert(result.height > result.artworkHeight);
  assertStringIncludes(result.pathData, "C ");
  assert(hasFractionalCoordinate(result.pathData));
  assert(!result.pathData.includes("Q "));
  assert(!result.svgText.includes("<image"));
});

Deno.test("sticker registry resolves sets from lightweight refs and display policy", async () => {
  const assets = await StickerArtCatalog.assets();
  const sets = await StickerArtCatalog.sets();

  assertEquals(assets.length, 58);
  assertEquals(sets.map((set) => set.id), [
    StickerArtCatalog.DEFAULT_SET_ID,
    "lona-food",
    "beluga-cats",
  ]);

  const pixelSet = await StickerArtCatalog.set(
    StickerArtCatalog.DEFAULT_SET_ID,
  );
  const belugaSet = await StickerArtCatalog.set("beluga-cats");
  assert(pixelSet);
  assert(belugaSet);
  assertEquals(pixelSet.name, "Pixel Town");
  assertEquals(pixelSet.assets.length, 40);
  assertEquals(pixelSet.assets.slice(-16).map((asset) => asset.id), [
    "flower-shrub",
    "hedge",
    "daisy-patch",
    "tulips",
    "sunflower",
    "lavender",
    "rose-bush",
    "bluebells",
    "sun",
    "cloud",
    "rain-cloud",
    "mountains",
    "hills",
    "moon",
    "stars",
    "rainbow",
  ]);
  assertEquals(belugaSet.name, "Beluga Cats");
  assertEquals(belugaSet.assets.map((asset) => asset.id), [
    "beluga-cat",
    "beluga-middle",
  ]);

  const beluga = belugaSet.assets[0];
  assertEquals(beluga.sourceKind, "image");
  assertEquals(beluga.imageRendering, "auto");
  assertEquals(beluga.pngPath, "/img/stickers/emoji/beluga-cat/beluga-cat.png");
  assertEquals(beluga.intrinsicWidth, 552);
  assertEquals(beluga.intrinsicHeight, 658);
  assertEquals(beluga.displayWidth, 81);
  assertEquals(beluga.displayHeight, 96);
  assertEquals(beluga.backgroundCleanup, null);
  assertEquals(beluga.trimTransparentPadding, false);
  assertEquals(beluga.license, null);

  const middle = belugaSet.assets[1];
  assertEquals(middle.sourceKind, "image");
  assertEquals(middle.imageRendering, "auto");
  assertEquals(
    middle.pngPath,
    "/img/stickers/emoji/beluga-cat/beluga-middle.png",
  );
  assertEquals(middle.intrinsicWidth, 363);
  assertEquals(middle.intrinsicHeight, 465);
  assertEquals(middle.displayWidth, 75);
  assertEquals(middle.displayHeight, 96);
  assertEquals(middle.backgroundCleanup, null);
  assertEquals(middle.trimTransparentPadding, false);
  assertEquals(middle.license, null);
});

Deno.test("sticker scale display policies can use registry dimensions before PNG bytes", async () => {
  const requestedTextPaths: string[] = [];
  const requestedPngPaths: string[] = [];
  const pngBytes = StickerCutoutOutline.pngDataUrlToBytes(ONE_PIXEL_PNG);
  StickerArtCatalog.configure({
    loadText: async (path) => {
      requestedTextPaths.push(path);
      if (path === StickerArtCatalog.REGISTRY_STATIC_PATH) {
        return JSON.stringify({
          format: "LONA-STICKER-REGISTRY 1",
          sets: [{
            id: "policy",
            name: "Policy",
            description: "Policy-backed",
            accent: "var(--purple)",
            imageRendering: "pixelated",
            display: {
              kind: "scale",
              scale: 3,
              intrinsicWidth: 1,
              intrinsicHeight: 1,
            },
            stickers: [{
              id: "policy-cat",
              pngPath: "/img/stickers/test/policy-cat.png",
            }],
          }],
        });
      }
      throw new Error(`unexpected metadata request ${path}`);
    },
    loadBytes: async (path) => {
      requestedPngPaths.push(path);
      return pngBytes;
    },
  });

  const asset = await StickerArtCatalog.asset("policy-cat");
  assert(asset);
  assertEquals(asset.intrinsicWidth, 1);
  assertEquals(asset.intrinsicHeight, 1);
  assertEquals(asset.displayScale, 3);
  assertEquals(asset.displayWidth, 3);
  assertEquals(asset.displayHeight, 3);
  assertEquals(asset.sourceKind, "pixel-art");
  assertEquals(asset.imageRendering, "pixelated");
  assertEquals(requestedTextPaths, [StickerArtCatalog.REGISTRY_STATIC_PATH]);
  assertEquals(requestedPngPaths, []);

  const result = await StickerArtCatalog.cutout("policy-cat");
  assert(result);
  assertEquals(result.rasterScale, 3);
  assertEquals(requestedPngPaths, ["/img/stickers/test/policy-cat.png"]);

  MockStickerPixelArtAsset.configureForTests(loadCatalogText, loadPngBytes);
});

Deno.test("beluga cat stickers clean and trim supplied PNGs", async () => {
  const asset = await StickerArtCatalog.asset("beluga-cat");
  assert(asset);
  const result = await StickerArtCatalog.cutout("beluga-cat");
  assert(result);
  assertEquals(result.metadata.width, 552);
  assertEquals(result.metadata.height, 658);
  assertEquals(result.artworkWidth, 552);
  assertEquals(result.artworkHeight, 658);
  assert(result.cutoutWidthPx > 6);
  assert(
    Math.abs(
      (result.cutoutWidthPx * asset.displayWidth) / result.artworkWidth - 6,
    ) <
      0.25,
  );
  assert(
    Math.abs(
      (result.cutoutWidthPx * asset.displayHeight) / result.artworkHeight - 6,
    ) <
      0.25,
  );
  assertStringIncludes(result.svgText, "<path");

  const middle = await StickerArtCatalog.asset("beluga-middle");
  assert(middle);
  const middleResult = await StickerArtCatalog.cutout("beluga-middle");
  assert(middleResult);
  assertEquals(middleResult.metadata.width, 363);
  assertEquals(middleResult.metadata.height, 465);
  assertEquals(middleResult.artworkWidth, 363);
  assertEquals(middleResult.artworkHeight, 465);
  assert(middleResult.cutoutWidthPx > 6);
  assert(
    Math.abs(
      (middleResult.cutoutWidthPx * middle.displayWidth) /
          middleResult.artworkWidth -
        6,
    ) < 0.25,
  );
  assert(
    Math.abs(
      (middleResult.cutoutWidthPx * middle.displayHeight) /
          middleResult.artworkHeight -
        6,
    ) < 0.25,
  );
  assertStringIncludes(middleResult.svgText, "<path");
});

Deno.test("sticker registry metadata is optional for rendering", async () => {
  StickerArtCatalog.configure({
    loadText: async (path) => {
      if (path !== StickerArtCatalog.REGISTRY_STATIC_PATH) {
        throw new Error(`missing optional metadata ${path}`);
      }
      return JSON.stringify({
        format: "LONA-STICKER-REGISTRY 1",
        sets: [{
          id: "fallback",
          name: "Fallback",
          description: "No metadata",
          accent: "var(--gray)",
          stickers: [{
            id: "plain-cat",
            pngPath: "/img/stickers/test/plain-cat.png",
          }],
        }],
      });
    },
    loadBytes: async () =>
      StickerCutoutOutline.pngDataUrlToBytes(ONE_PIXEL_PNG),
  });

  const stickerSet = await StickerArtCatalog.set("fallback");
  assert(stickerSet);
  const asset = stickerSet.assets[0];
  assertEquals(asset.id, "plain-cat");
  assertEquals(asset.label, "Plain Cat");
  assertEquals(asset.sourceKind, "image");
  assertEquals(asset.imageRendering, "auto");

  const result = await StickerArtCatalog.cutout(asset.id);
  assert(result);

  MockStickerPixelArtAsset.configureForTests(loadCatalogText, loadPngBytes);
});

Deno.test("sticker set lookup loads metadata only for the requested set", async () => {
  const requestedPaths: string[] = [];
  StickerArtCatalog.configure({
    loadText: async (path) => {
      requestedPaths.push(path);
      if (path === StickerArtCatalog.REGISTRY_STATIC_PATH) {
        return JSON.stringify({
          format: "LONA-STICKER-REGISTRY 1",
          sets: [
            {
              id: "one",
              name: "One",
              description: "One",
              accent: "var(--gray)",
              stickers: [{
                id: "one-a",
                pngPath: "/img/stickers/test/one-a.png",
              }],
            },
            {
              id: "two",
              name: "Two",
              description: "Two",
              accent: "var(--purple)",
              stickers: [{
                id: "two-a",
                pngPath: "/img/stickers/test/two-a.png",
              }],
            },
          ],
        });
      }
      if (path === "/img/stickers/test/one-a.sticker.json") {
        return JSON.stringify({
          format: "LONA-STICKER-METADATA 1",
          label: "One A",
        });
      }
      throw new Error(`unexpected metadata request ${path}`);
    },
    loadBytes: loadPngBytes,
  });

  const summaries = await StickerArtCatalog.setSummaries();
  assertEquals(summaries.map((summary) => summary.id), ["one", "two"]);
  assertEquals(requestedPaths, [StickerArtCatalog.REGISTRY_STATIC_PATH]);

  const one = await StickerArtCatalog.set("one");
  assert(one);
  assertEquals(one.assets.map((asset) => asset.id), ["one-a"]);
  assertEquals(one.assets[0].label, "One A");
  assertEquals(requestedPaths, [
    StickerArtCatalog.REGISTRY_STATIC_PATH,
    "/img/stickers/test/one-a.sticker.json",
  ]);

  MockStickerPixelArtAsset.configureForTests(loadCatalogText, loadPngBytes);
});

Deno.test("sticker registry rejects duplicate set ids", async () => {
  StickerArtCatalog.configure({
    loadText: async (path) => {
      assertEquals(path, StickerArtCatalog.REGISTRY_STATIC_PATH);
      return JSON.stringify({
        format: "LONA-STICKER-REGISTRY 1",
        sets: [
          {
            id: "duplicate",
            name: "One",
            description: "One",
            accent: "var(--gray)",
            stickers: [],
          },
          {
            id: "duplicate",
            name: "Two",
            description: "Two",
            accent: "var(--gray)",
            stickers: [],
          },
        ],
      });
    },
    loadBytes: loadPngBytes,
  });

  await assertRejects(
    () => StickerArtCatalog.set("duplicate"),
    Error,
    'duplicate sticker set id "duplicate"',
  );

  MockStickerPixelArtAsset.configureForTests(loadCatalogText, loadPngBytes);
});

Deno.test("sticker registry rejects one sticker id pointing at multiple PNGs", async () => {
  StickerArtCatalog.configure({
    loadText: async (path) => {
      assertEquals(path, StickerArtCatalog.REGISTRY_STATIC_PATH);
      return JSON.stringify({
        format: "LONA-STICKER-REGISTRY 1",
        sets: [
          {
            id: "one",
            name: "One",
            description: "One",
            accent: "var(--gray)",
            stickers: [{
              id: "same",
              pngPath: "/img/stickers/test/one.png",
            }],
          },
          {
            id: "two",
            name: "Two",
            description: "Two",
            accent: "var(--gray)",
            stickers: [{
              id: "same",
              pngPath: "/img/stickers/test/two.png",
            }],
          },
        ],
      });
    },
    loadBytes: loadPngBytes,
  });

  await assertRejects(
    () => StickerArtCatalog.assets(),
    Error,
    'sticker id "same" has multiple PNG paths',
  );

  MockStickerPixelArtAsset.configureForTests(loadCatalogText, loadPngBytes);
});

Deno.test("built-in pixel sticker set uses owned hosted chunky PNG sources", async () => {
  const stickerSet = await StickerArtCatalog.set(
    StickerArtCatalog.DEFAULT_SET_ID,
  );
  assert(stickerSet);
  const assets = stickerSet.assets;
  assertEquals(assets.length, 40);
  for (const asset of assets) {
    assertEquals(asset.license, null);
    assertEquals(asset.sourceUrl, asset.pngPath);
    assert(asset.sourceFilename.endsWith(".png"));
    assert(asset.pngPath.startsWith(PNG_STATIC_PREFIX));
    assertEquals(
      asset.intrinsicWidth,
      MockStickerPixelArtAsset.PIXEL_ART_SOURCE_WIDTH_PX,
    );
    assertEquals(
      asset.intrinsicHeight,
      MockStickerPixelArtAsset.PIXEL_ART_SOURCE_HEIGHT_PX,
    );
    assertEquals(
      asset.rasterScale,
      MockStickerPixelArtAsset.PIXEL_ART_RASTER_SCALE,
    );
    assertEquals(
      asset.rasterWidth,
      MockStickerPixelArtAsset.PIXEL_ART_DISPLAY_SIZE_PX,
    );
    assertEquals(
      asset.rasterHeight,
      MockStickerPixelArtAsset.PIXEL_ART_DISPLAY_SIZE_PX,
    );
    assertEquals(
      asset.displayWidth,
      MockStickerPixelArtAsset.PIXEL_ART_DISPLAY_SIZE_PX,
    );
    assertEquals(
      asset.displayHeight,
      MockStickerPixelArtAsset.PIXEL_ART_DISPLAY_SIZE_PX,
    );
    assertEquals(asset.sourceKind, "pixel-art");
    assertEquals(asset.imageRendering, "pixelated");

    const result = await StickerArtCatalog.cutout(asset.id);
    assert(result);
    assertEquals(result.metadata.width, asset.intrinsicWidth);
    assertEquals(result.metadata.height, asset.intrinsicHeight);
    assertEquals(result.rasterScale, asset.displayScale);
    assertEquals(result.scale, asset.displayScale);
    assertEquals(result.cutoutWidthPx, 6);
    assertEquals(result.artworkWidth, asset.rasterWidth);
    assertEquals(result.artworkHeight, asset.rasterHeight);
    assertEquals(asset.displayWidth, result.artworkWidth);
    assertEquals(asset.displayHeight, result.artworkHeight);

    const rasterMetadata = StickerCutoutOutline.parsePngMetadata(
      StickerCutoutOutline.pngDataUrlToBytes(result.pngDataUrl),
    );
    assertEquals(rasterMetadata.width, asset.rasterWidth);
    assertEquals(rasterMetadata.height, asset.rasterHeight);
  }
});

Deno.test("sticker cutout exposes the outer perimeter polygon for packing", async () => {
  const result = await cutoutFromAsset(
    await requiredAsset("map-marker"),
    "fixture-note-perimeter",
    {
      fill: "#ffffff",
      cutoutWidthPx: 8,
      smoothingPx: 4,
    },
  );

  assert(result.outlineLoops.length >= 1);
  assert(result.perimeter.length >= 3);
  let maxAbs = -1;
  for (const loop of result.outlineLoops) {
    maxAbs = Math.max(maxAbs, Math.abs(shoelace(loop)));
  }
  assertEquals(Math.abs(shoelace(result.perimeter)), maxAbs);
  for (const p of result.perimeter) {
    assert(p.x >= 0 && p.x <= result.width);
    assert(p.y >= 0 && p.y <= result.height);
  }
});

Deno.test("sticker cutout handles transparent owned pixel fixtures", async () => {
  const asset = await requiredAsset("toadstools");
  const result = await cutoutFromAsset(asset, "fixture-heart-transparent", {
    fill: "#ffffff",
    cutoutWidthPx: 6,
    smoothingPx: 3,
  });

  assertEquals(result.artworkWidth, asset.rasterWidth);
  assertEquals(result.artworkHeight, asset.rasterHeight);
  assert(result.outlineLoops.length >= 1);
  assert(result.perimeter.length >= 3);
  assert(result.pathData.length > 0);
});

Deno.test("sticker cutout style options adjust generated outline shape", async () => {
  const asset = await requiredAsset("wildflowers");
  const image = await imageFromAsset(asset);
  const narrow = StickerCutoutOutline.generateSvgFromRgbaImage(image, {
    id: "fixture-style-narrow",
    rasterScale: asset.displayScale,
    style: { fill: "#ffffff", cutoutWidthPx: 3, smoothingPx: 1 },
  });
  const wide = StickerCutoutOutline.generateSvgFromRgbaImage(image, {
    id: "fixture-style-wide",
    rasterScale: asset.displayScale,
    style: { fill: "#ffffff", cutoutWidthPx: 12, smoothingPx: 1 },
  });
  const unsmoothed = StickerCutoutOutline.generateSvgFromRgbaImage(image, {
    id: "fixture-style-unsmoothed",
    rasterScale: asset.displayScale,
    style: { fill: "#ffffff", cutoutWidthPx: 6, smoothingPx: 0 },
  });
  const smoothed = StickerCutoutOutline.generateSvgFromRgbaImage(image, {
    id: "fixture-style-smoothed",
    rasterScale: asset.displayScale,
    style: { fill: "#ffffff", cutoutWidthPx: 6, smoothingPx: 8 },
  });
  const edgeBleed = StickerCutoutOutline.generateSvgFromRgbaImage(image, {
    id: "fixture-style-edge-bleed",
    rasterScale: asset.displayScale,
    style: {
      fill: "#ffffff",
      cutoutWidthPx: 6,
      smoothingPx: 1,
      edgeBleedPx: 0.5,
    },
  });

  assertEquals(narrow.cutoutWidthPx, 3);
  assertEquals(narrow.smoothingPx, 1);
  assertEquals(wide.cutoutWidthPx, 12);
  assertEquals(wide.smoothingPx, 1);
  assertEquals(unsmoothed.smoothingPx, 0);
  assertEquals(smoothed.smoothingPx, 8);
  assertEquals(edgeBleed.alphaThreshold, 64);
  assertEquals(edgeBleed.edgeBleedPx, 0.5);
  assert(pathBoundsWidth(wide.pathData) > pathBoundsWidth(narrow.pathData));
  assert(pathBoundsHeight(wide.pathData) > pathBoundsHeight(narrow.pathData));
  assertEquals(unsmoothed.width, smoothed.width);
  assertEquals(unsmoothed.height, smoothed.height);
  assertEquals(countCubicSegments(unsmoothed.pathData), 0);
  assert(countCubicSegments(smoothed.pathData) > 0);
  assert(unsmoothed.pathData !== smoothed.pathData);
  assertStringIncludes(edgeBleed.svgText, 'stroke="#ffffff"');
  assertStringIncludes(edgeBleed.svgText, 'stroke-width="0.500"');
});

Deno.test("sticker cutout supports multiple vector smoothing techniques", async () => {
  const asset = await requiredAsset("map-marker");
  const image = await imageFromAsset(asset);
  const results = (["catmull-rom", "chaikin", "chaikin-cubic"] as const).map(
    (technique) =>
      StickerCutoutOutline.generateSvgFromRgbaImage(image, {
        id: `fixture-note-${technique}`,
        rasterScale: asset.displayScale,
        style: {
          paddingPx: 40,
          cutoutWidthPx: 8,
          smoothingPx: 4,
          technique,
          fill: "#ffffff",
        },
      }),
  );
  const [catmullRom, chaikin, chaikinCubic] = results;

  for (const result of results) {
    assert(result.pathData.length > 0);
    assertEquals(
      result.metadata.width,
      MockStickerPixelArtAsset.PIXEL_ART_SOURCE_WIDTH_PX,
    );
    assertEquals(
      result.metadata.height,
      MockStickerPixelArtAsset.PIXEL_ART_SOURCE_HEIGHT_PX,
    );
    assert(!result.svgText.includes("<image"));
  }

  assertEquals(catmullRom.technique, "catmull-rom");
  assertEquals(chaikin.technique, "chaikin");
  assertEquals(chaikinCubic.technique, "chaikin-cubic");
  assert(countCubicSegments(catmullRom.pathData) > 0);
  assertEquals(countCubicSegments(chaikin.pathData), 0);
  assert(countCubicSegments(chaikinCubic.pathData) > 0);
  assert(countLineSegments(chaikin.pathData) > 0);
  assert(catmullRom.pathData !== chaikin.pathData);
  assert(catmullRom.pathData !== chaikinCubic.pathData);
  assert(chaikin.pathData !== chaikinCubic.pathData);
});

Deno.test("sticker cutout builds an inner-shadow svg layer from a path", () => {
  const pathData = "M 0 0 C 1 1 2 2 3 3 Z";
  const svg = StickerCutoutOutline.buildInnerShadowSvg(
    pathData,
    "0 0 20 20",
    20,
    20,
    { dxPx: 0, dyPx: 1.5, blurPx: 2.5, color: "#000000", opacity: 0.35 },
  );

  assertStringIncludes(svg, "feComponentTransfer");
  assertStringIncludes(svg, "feGaussianBlur");
  assertStringIncludes(svg, "feFlood");
  assertStringIncludes(svg, 'operator="in"');
  assertStringIncludes(svg, 'in2="SourceAlpha"');
  assertStringIncludes(svg, pathData);
  assert(!svg.includes("feDropShadow"));
});

async function loadCatalogText(path: string): Promise<string> {
  if (path === StickerArtCatalog.REGISTRY_STATIC_PATH) {
    return Deno.readTextFile(STICKER_REGISTRY_FILE);
  }
  if (path.startsWith(STICKER_STATIC_PREFIX) && path.endsWith(".json")) {
    return Deno.readTextFile(
      `${STICKER_FILE_PREFIX}${path.slice(STICKER_STATIC_PREFIX.length)}`,
    );
  }
  throw new Error(`Unexpected sticker text path "${path}"`);
}

function localPngPath(path: string): string {
  if (!path.startsWith(STICKER_STATIC_PREFIX)) {
    throw new Error(`Unexpected PNG path "${path}"`);
  }
  return `${STICKER_FILE_PREFIX}${path.slice(STICKER_STATIC_PREFIX.length)}`;
}

async function loadPngBytes(path: string): Promise<Uint8Array> {
  return Deno.readFile(localPngPath(path));
}

async function requiredAsset(id: string): Promise<StickerArtCatalog.Asset> {
  const asset = await StickerArtCatalog.asset(id);
  assert(asset);
  return asset;
}

async function imageFromAsset(
  asset: StickerArtCatalog.Asset,
): Promise<PixelImage.RgbaImage> {
  return PixelImage.decodePng(await loadPngBytes(asset.pngPath));
}

function assertPixel(
  image: PixelImage.RgbaImage,
  x: number,
  y: number,
  rgba: readonly number[],
): void {
  const offset = (y * image.width + x) * 4;
  assertEquals([...image.data.slice(offset, offset + 4)], rgba);
}

function hasAlpha(image: PixelImage.RgbaImage, alpha: number): boolean {
  for (let offset = 3; offset < image.data.length; offset += 4) {
    if (image.data[offset] === alpha) return true;
  }
  return false;
}

async function cutoutFromAsset(
  asset: StickerArtCatalog.Asset,
  id: string,
  style: StickerCutoutOutline.Style,
): Promise<StickerCutoutOutline.Result> {
  return StickerCutoutOutline.generateSvgFromRgbaImage(
    await imageFromAsset(asset),
    {
      id,
      rasterScale: asset.displayScale,
      style,
    },
  );
}

function shoelace(loop: { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function countCubicSegments(pathData: string): number {
  return pathData.split("C ").length - 1;
}

function countLineSegments(pathData: string): number {
  return pathData.split("L ").length - 1;
}

function hasFractionalCoordinate(pathData: string): boolean {
  for (const part of pathData.split(/[^0-9.-]+/)) {
    if (part.length === 0) continue;

    const value = Number(part);
    if (!Number.isFinite(value)) continue;
    if (Math.abs(value - Math.round(value)) > 0.001) return true;
  }

  return false;
}

function pathBoundsWidth(pathData: string): number {
  const bounds = pathBounds(pathData);
  return bounds.maxX - bounds.minX;
}

function pathBoundsHeight(pathData: string): number {
  const bounds = pathBounds(pathData);
  return bounds.maxY - bounds.minY;
}

function pathBounds(pathData: string): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const values = pathData
    .split(/[^0-9.-]+/)
    .filter((part) => part.length > 0)
    .map(Number)
    .filter(Number.isFinite);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < values.length - 1; i += 2) {
    const x = values[i];
    const y = values[i + 1];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return { minX, minY, maxX, maxY };
}
