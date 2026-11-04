/**
 * `PixelImage` — PNG decode / encode and sticker cleanup over raw RGBA bytes.
 * DOM-free: the only platform surface it touches is the byte-stream
 * compression pair, declared below.
 *
 * Lives in `@tento-core` so both the lona SDK (`@tento-lona` re-exports it) and
 * the UI kit (`tento-ui-js` sticker outlines) import it downward.
 */

// The core tsconfig compiles without the DOM lib, so the streaming
// compression surface is declared here, module-local and structural: just the
// members this module touches. Module scope shadows the global declarations
// for type-checking only; at runtime each name resolves to the platform global
// (browser, Deno, workers).
type PixelByteReader = {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
};
type PixelTransform = { readonly readable: unknown; readonly writable: unknown };
type PixelByteStream = {
  pipeThrough(transform: PixelTransform): PixelByteStream;
  getReader(): PixelByteReader;
};
declare const Blob: { new (parts: ArrayBuffer[]): { stream(): PixelByteStream } };
declare const CompressionStream: { new (format: "deflate" | "deflate-raw"): PixelTransform };
declare const DecompressionStream: { new (format: "deflate" | "deflate-raw"): PixelTransform };

/**
 * PNG encoding and decoding for small RGBA pixel images (stickers, icons),
 * with no DOM.
 */
export namespace PixelImage {
  export type PngColorType = 0 | 2 | 3 | 4 | 6;

  export type Rgba = {
    r: number;
    g: number;
    b: number;
    a: number;
  };

  export type RgbaImage = {
    width: number;
    height: number;
    data: Uint8Array;
  };

  export type Bounds = {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  export type BackgroundCleanup = "edge-checkerboard";

  export type StickerCleanupOptions = {
    backgroundCleanup: Option<BackgroundCleanup>;
    trimTransparentPadding: boolean;
    alphaThreshold: number;
  };

  export type PngMetadata = {
    width: number;
    height: number;
    bitDepth: number;
    colorType: PngColorType;
    hasTransparency: boolean;
    interlaceMethod: number;
  };

  export function parsePngMetadata(pngBytes: Uint8Array): PngMetadata {
    return parsePng(pngBytes).metadata;
  }

  export async function decodePng(pngBytes: Uint8Array): Promise<RgbaImage> {
    const png = parsePng(pngBytes);
    const { metadata } = png;
    validateDecodeSupport(metadata);
    if (metadata.colorType === 3 && !png.palette) {
      throw new Error("Indexed-color PNG is missing a PLTE chunk");
    }

    const inflated = await inflateZlib(png.compressedData);
    const bitsPerPixel = pngBitsPerPixel(metadata);
    const rowBytes = Math.ceil((metadata.width * bitsPerPixel) / 8);
    const filterBytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
    const expectedLength = (rowBytes + 1) * metadata.height;
    if (inflated.length < expectedLength) {
      throw new Error(
        `PNG data is shorter than expected: ${inflated.length} < ${expectedLength}`,
      );
    }

    const rgba = new Uint8Array(metadata.width * metadata.height * 4);
    let prevRow: Uint8Array = new Uint8Array(rowBytes);
    let inputOffset = 0;

    for (let y = 0; y < metadata.height; y++) {
      const filterType = inflated[inputOffset];
      const encodedRow = inflated.slice(
        inputOffset + 1,
        inputOffset + 1 + rowBytes,
      );
      const row = unfilterRow(
        encodedRow,
        prevRow,
        filterBytesPerPixel,
        filterType,
      );

      for (let x = 0; x < metadata.width; x++) {
        writeRgbaPixel(rgba, row, x, y, metadata, png.palette, png.transparency);
      }

      prevRow = row;
      inputOffset += rowBytes + 1;
    }

    return {
      width: metadata.width,
      height: metadata.height,
      data: rgba,
    };
  }

  export function encodePng(image: RgbaImage): Uint8Array {
    assertRgbaImage(image);
    return encodePngWithIdat(image, zlibStore(filteredRgbaBytes(image)));
  }

  export async function encodePngCompressed(
    image: RgbaImage,
  ): Promise<Uint8Array> {
    assertRgbaImage(image);
    const filtered = filteredRgbaBytes(image);
    return encodePngWithIdat(image, await zlibDeflate(filtered));
  }

  function filteredRgbaBytes(image: RgbaImage): Uint8Array {
    const stride = image.width * 4;
    const filtered = new Uint8Array((stride + 1) * image.height);
    let outputOffset = 0;
    let inputOffset = 0;
    let prevRow = new Uint8Array(stride);
    for (let y = 0; y < image.height; y++) {
      const row = image.data.slice(inputOffset, inputOffset + stride);
      const encodedRow = bestFilteredRow(row, prevRow, 4);
      filtered.set(encodedRow, outputOffset);
      outputOffset += stride + 1;
      inputOffset += stride;
      prevRow = row;
    }
    return filtered;
  }

  function bestFilteredRow(
    row: Uint8Array,
    prevRow: Uint8Array,
    bytesPerPixel: number,
  ): Uint8Array {
    let bestType = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let filterType = 0; filterType <= 4 && bestScore > 0; filterType++) {
      const score = filterScore(row, prevRow, bytesPerPixel, filterType, bestScore);
      if (score < bestScore) {
        bestScore = score;
        bestType = filterType;
      }
    }
    return filterRow(row, prevRow, bytesPerPixel, bestType);
  }

  function filterScore(
    row: Uint8Array,
    prevRow: Uint8Array,
    bytesPerPixel: number,
    filterType: number,
    cutoff: number,
  ): number {
    let score = 0;
    // Magnitudes cannot reduce the score; ties already belong to the earlier
    // filter. Stop scoring a candidate as soon as it cannot win.
    for (let start = 0; start < row.length && score < cutoff; start += 64) {
      const end = Math.min(start + 64, row.length);
      for (let i = start; i < end; i++) {
        score += byteMagnitude(
          filteredByte(row, prevRow, bytesPerPixel, filterType, i),
        );
      }
    }
    return score;
  }

  function filterRow(
    row: Uint8Array,
    prevRow: Uint8Array,
    bytesPerPixel: number,
    filterType: number,
  ): Uint8Array {
    const encoded = new Uint8Array(row.length + 1);
    encoded[0] = filterType;
    for (let i = 0; i < row.length; i++) {
      encoded[i + 1] = filteredByte(
        row,
        prevRow,
        bytesPerPixel,
        filterType,
        i,
      );
    }
    return encoded;
  }

  function filteredByte(
    row: Uint8Array,
    prevRow: Uint8Array,
    bytesPerPixel: number,
    filterType: number,
    index: number,
  ): number {
    const value = row[index];
    if (filterType === 0) return value;

    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
    const up = prevRow[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? prevRow[index - bytesPerPixel] : 0;
    if (filterType === 1) return (value - left) & 255;
    if (filterType === 2) return (value - up) & 255;
    if (filterType === 3) return (value - Math.floor((left + up) / 2)) & 255;
    return (value - paethPredictor(left, up, upLeft)) & 255;
  }

  function byteMagnitude(value: number): number {
    return value < 128 ? value : 256 - value;
  }

  function encodePngWithIdat(
    image: RgbaImage,
    idatData: Uint8Array,
  ): Uint8Array {
    return concatChunks([
      new Uint8Array(PNG_SIGNATURE),
      pngChunk("IHDR", new Uint8Array([
        ...uint32Bytes(image.width),
        ...uint32Bytes(image.height),
        8,
        6,
        0,
        0,
        0,
      ])),
      pngChunk("IDAT", idatData),
      pngChunk("IEND", new Uint8Array()),
    ]);
  }

  export function metadataFromRgbaImage(image: RgbaImage): PngMetadata {
    assertRgbaImage(image);

    let hasTransparency = false;
    for (let offset = 3; offset < image.data.length; offset += 4) {
      if (image.data[offset] < 255) {
        hasTransparency = true;
        break;
      }
    }

    return {
      width: image.width,
      height: image.height,
      bitDepth: 8,
      colorType: 6,
      hasTransparency,
      interlaceMethod: 0,
    };
  }

  export function scaleNearest(image: RgbaImage, scale: number): RgbaImage {
    assertRgbaImage(image);
    assertPositiveInteger(scale, "PixelImage scale");
    if (scale === 1) {
      return {
        width: image.width,
        height: image.height,
        data: new Uint8Array(image.data),
      };
    }

    const width = image.width * scale;
    const height = image.height * scale;
    const data = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
      const sourceY = Math.floor(y / scale);
      for (let x = 0; x < width; x++) {
        const sourceX = Math.floor(x / scale);
        const sourceOffset = (sourceY * image.width + sourceX) * 4;
        const targetOffset = (y * width + x) * 4;
        data[targetOffset] = image.data[sourceOffset];
        data[targetOffset + 1] = image.data[sourceOffset + 1];
        data[targetOffset + 2] = image.data[sourceOffset + 2];
        data[targetOffset + 3] = image.data[sourceOffset + 3];
      }
    }

    return { width, height, data };
  }

  export function cleanForStickerUse(
    image: RgbaImage,
    options: StickerCleanupOptions,
  ): RgbaImage {
    assertRgbaImage(image);
    assertAlphaThreshold(options.alphaThreshold);

    const backgroundCleanedImage =
      options.backgroundCleanup === "edge-checkerboard"
        ? removeCheckerboardBackground(image)
        : image;
    if (!options.trimTransparentPadding) {
      return cloneRgbaImage(backgroundCleanedImage);
    }
    return trimTransparentPadding(
      backgroundCleanedImage,
      options.alphaThreshold,
    );
  }

  export function trimTransparentPadding(
    image: RgbaImage,
    alphaThreshold: number,
  ): RgbaImage {
    assertRgbaImage(image);
    assertAlphaThreshold(alphaThreshold);

    const bounds = visibleBounds(image, alphaThreshold);
    if (!bounds) {
      return cloneRgbaImage(image);
    }
    if (
      bounds.x === 0 &&
      bounds.y === 0 &&
      bounds.width === image.width &&
      bounds.height === image.height
    ) {
      return cloneRgbaImage(image);
    }

    const data = new Uint8Array(bounds.width * bounds.height * 4);
    for (let y = 0; y < bounds.height; y++) {
      const sourceOffset = ((bounds.y + y) * image.width + bounds.x) * 4;
      const targetOffset = y * bounds.width * 4;
      data.set(
        image.data.slice(sourceOffset, sourceOffset + bounds.width * 4),
        targetOffset,
      );
    }

    return {
      width: bounds.width,
      height: bounds.height,
      data,
    };
  }

  export function removeCheckerboardBackground(image: RgbaImage): RgbaImage {
    assertRgbaImage(image);

    const data = new Uint8Array(image.data);
    const visited = new Uint8Array(image.width * image.height);
    const queue: number[] = [];

    for (let x = 0; x < image.width; x++) {
      enqueueBackgroundPixel(image, data, visited, queue, x, 0);
      enqueueBackgroundPixel(
        image,
        data,
        visited,
        queue,
        x,
        image.height - 1,
      );
    }
    for (let y = 1; y < image.height - 1; y++) {
      enqueueBackgroundPixel(image, data, visited, queue, 0, y);
      enqueueBackgroundPixel(
        image,
        data,
        visited,
        queue,
        image.width - 1,
        y,
      );
    }

    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor];
      const x = index % image.width;
      const y = Math.floor(index / image.width);
      const alphaOffset = index * 4 + 3;
      data[alphaOffset] = 0;

      if (x > 0) {
        enqueueBackgroundPixel(image, data, visited, queue, x - 1, y);
      }
      if (x + 1 < image.width) {
        enqueueBackgroundPixel(image, data, visited, queue, x + 1, y);
      }
      if (y > 0) {
        enqueueBackgroundPixel(image, data, visited, queue, x, y - 1);
      }
      if (y + 1 < image.height) {
        enqueueBackgroundPixel(image, data, visited, queue, x, y + 1);
      }
    }

    return {
      width: image.width,
      height: image.height,
      data,
    };
  }

  export function pngBytesToDataUrl(pngBytes: Uint8Array): string {
    return `data:image/png;base64,${bytesToBase64(pngBytes)}`;
  }

  export function pngDataUrlToBytes(dataUrl: string): Uint8Array {
    const marker = "base64,";
    const markerIndex = dataUrl.indexOf(marker);
    if (!dataUrl.startsWith("data:image/png") || markerIndex < 0) {
      throw new Error("Expected a base64 PNG data URL");
    }
    return base64ToBytes(dataUrl.slice(markerIndex + marker.length));
  }

  function visibleBounds(
    image: RgbaImage,
    alphaThreshold: number,
  ): Option<Bounds> {
    let minX = image.width;
    let minY = image.height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const alpha = image.data[(y * image.width + x) * 4 + 3];
        if (alpha < alphaThreshold) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }

    if (maxX < minX || maxY < minY) return null;
    return {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };
  }

  function cloneRgbaImage(image: RgbaImage): RgbaImage {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8Array(image.data),
    };
  }

  function enqueueBackgroundPixel(
    image: RgbaImage,
    data: Uint8Array,
    visited: Uint8Array,
    queue: number[],
    x: number,
    y: number,
  ): void {
    const index = y * image.width + x;
    if (visited[index]) return;
    visited[index] = 1;
    if (!isCheckerboardBackgroundPixel(data, index * 4)) return;
    queue.push(index);
  }

  function isCheckerboardBackgroundPixel(
    data: Uint8Array,
    offset: number,
  ): boolean {
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const a = data[offset + 3];
    if (a < 255) return false;
    const min = Math.min(r, g, b);
    const max = Math.max(r, g, b);
    if (max - min > 3) return false;
    return (
      Math.abs(r - 255) <= 4 ||
      Math.abs(r - 240) <= 4 ||
      Math.abs(r - 235) <= 4
    );
  }
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CRC_TABLE = buildCrcTable();

type PngData = {
  metadata: PixelImage.PngMetadata;
  compressedData: Uint8Array;
  palette: Option<readonly Rgb[]>;
  transparency: Option<TransparencyData>;
};

type TransparencyData = {
  paletteAlpha: Option<Uint8Array>;
  transparentGray: Option<number>;
  transparentRgb: Option<Rgb>;
};

type Rgb = {
  r: number;
  g: number;
  b: number;
};

function parsePng(pngBytes: Uint8Array): PngData {
  assertPngSignature(pngBytes);

  let offset: number = PNG_SIGNATURE.length;
  let metadata: Option<PixelImage.PngMetadata> = null;
  let palette: Option<readonly Rgb[]> = null;
  let transparency: Option<TransparencyData> = null;
  const idatChunks: Uint8Array[] = [];

  while (offset + 12 <= pngBytes.length) {
    const chunkLength = readUint32(pngBytes, offset);
    const chunkType = readChunkType(pngBytes, offset + 4);
    const dataOffset = offset + 8;
    const nextOffset = dataOffset + chunkLength + 4;

    if (nextOffset > pngBytes.length) {
      throw new Error(`PNG chunk ${chunkType} exceeds file length`);
    }

    const chunkData = pngBytes.slice(dataOffset, dataOffset + chunkLength);

    if (chunkType === "IHDR") {
      metadata = parseIhdr(chunkData);
    } else if (chunkType === "PLTE") {
      palette = parsePalette(chunkData);
    } else if (chunkType === "tRNS") {
      if (!metadata) {
        throw new Error("PNG tRNS chunk appeared before IHDR");
      }
      transparency = parseTransparency(chunkData, metadata.colorType);
    } else if (chunkType === "IDAT") {
      idatChunks.push(chunkData);
    } else if (chunkType === "IEND") {
      break;
    }

    offset = nextOffset;
  }

  if (!metadata) {
    throw new Error("PNG is missing an IHDR chunk");
  }
  if (idatChunks.length === 0) {
    throw new Error("PNG is missing IDAT data");
  }

  return {
    metadata: {
      ...metadata,
      hasTransparency: metadata.hasTransparency || transparency != null,
    },
    compressedData: concatChunks(idatChunks),
    palette,
    transparency,
  };
}

function assertPngSignature(pngBytes: Uint8Array): void {
  if (pngBytes.length < PNG_SIGNATURE.length) {
    throw new Error("PNG is shorter than the file signature");
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (pngBytes[i] !== PNG_SIGNATURE[i]) {
      throw new Error("Expected a PNG file signature");
    }
  }
}

function parseIhdr(chunkData: Uint8Array): PixelImage.PngMetadata {
  if (chunkData.length !== 13) {
    throw new Error(`PNG IHDR has invalid length ${chunkData.length}`);
  }

  const colorType = chunkData[9];
  if (!isPngColorType(colorType)) {
    throw new Error(`Unsupported PNG color type ${colorType}`);
  }

  return {
    width: readUint32(chunkData, 0),
    height: readUint32(chunkData, 4),
    bitDepth: chunkData[8],
    colorType,
    hasTransparency: colorType === 4 || colorType === 6,
    interlaceMethod: chunkData[12],
  };
}

function isPngColorType(
  value: number,
): value is PixelImage.PngColorType {
  return value === 0 || value === 2 || value === 3 || value === 4 ||
    value === 6;
}

function parsePalette(chunkData: Uint8Array): readonly Rgb[] {
  if (chunkData.length === 0 || chunkData.length % 3 !== 0) {
    throw new Error("PNG PLTE chunk length must be a positive multiple of 3");
  }
  if (chunkData.length > 768) {
    throw new Error("PNG PLTE chunk cannot contain more than 256 colors");
  }

  const palette: Rgb[] = [];
  for (let offset = 0; offset < chunkData.length; offset += 3) {
    palette.push({
      r: chunkData[offset],
      g: chunkData[offset + 1],
      b: chunkData[offset + 2],
    });
  }
  return palette;
}

function parseTransparency(
  chunkData: Uint8Array,
  colorType: PixelImage.PngColorType,
): TransparencyData {
  if (colorType === 3) {
    return {
      paletteAlpha: chunkData,
      transparentGray: null,
      transparentRgb: null,
    };
  }
  if (colorType === 0 && chunkData.length >= 2) {
    return {
      paletteAlpha: null,
      transparentGray: readUint16(chunkData, 0),
      transparentRgb: null,
    };
  }
  if (colorType === 2 && chunkData.length >= 6) {
    return {
      paletteAlpha: null,
      transparentGray: null,
      transparentRgb: {
        r: readUint16(chunkData, 0),
        g: readUint16(chunkData, 2),
        b: readUint16(chunkData, 4),
      },
    };
  }
  return {
    paletteAlpha: null,
    transparentGray: null,
    transparentRgb: null,
  };
}

function validateDecodeSupport(metadata: PixelImage.PngMetadata): void {
  if (metadata.interlaceMethod !== 0) {
    throw new Error("Interlaced PNGs are not supported");
  }
  if (metadata.colorType === 3) {
    if (
      metadata.bitDepth !== 1 &&
      metadata.bitDepth !== 2 &&
      metadata.bitDepth !== 4 &&
      metadata.bitDepth !== 8
    ) {
      throw new Error(
        `Indexed-color PNG bit depth must be 1, 2, 4, or 8; got ${metadata.bitDepth}`,
      );
    }
    return;
  }
  if (metadata.bitDepth !== 8) {
    throw new Error(`Only 8-bit non-indexed PNGs are supported, got ${metadata.bitDepth}`);
  }
}

function pngBitsPerPixel(metadata: PixelImage.PngMetadata): number {
  return pngSamplesPerPixel(metadata.colorType) * metadata.bitDepth;
}

function pngSamplesPerPixel(colorType: PixelImage.PngColorType): number {
  if (colorType === 0 || colorType === 3) return 1;
  if (colorType === 4) return 2;
  if (colorType === 2) return 3;
  return 4;
}

async function inflateZlib(compressedData: Uint8Array): Promise<Uint8Array> {
  const rawDeflateData = stripZlibWrapper(compressedData);
  const rawInflated = await inflateCompressedData(
    rawDeflateData,
    "deflate-raw",
  ).catch(() => null);
  if (rawInflated) return rawInflated;

  return inflateCompressedData(compressedData, "deflate");
}

async function inflateCompressedData(
  compressedData: Uint8Array,
  format: "deflate" | "deflate-raw",
): Promise<Uint8Array> {
  const stream = new Blob([copyToArrayBuffer(compressedData)])
    .stream()
    .pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const result = await reader.read();
    if (result.done || result.value == null) break;
    chunks.push(result.value);
  }

  return concatChunks(chunks);
}

async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const rawDeflateData = await deflateRaw(data);
  return concatChunks([
    new Uint8Array([0x78, 0x9c]),
    rawDeflateData,
    new Uint8Array(uint32Bytes(adler32(data))),
  ]);
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([copyToArrayBuffer(data)])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const result = await reader.read();
    if (result.done || result.value == null) break;
    chunks.push(result.value);
  }

  return concatChunks(chunks);
}

function stripZlibWrapper(compressedData: Uint8Array): Uint8Array {
  if (compressedData.length < 6) {
    throw new Error("PNG zlib stream is shorter than the required wrapper");
  }

  const compressionMethod = compressedData[0] & 15;
  const compressionInfo = compressedData[0] >> 4;
  const flags = compressedData[1];
  const checksum = compressedData[0] * 256 + flags;

  if (compressionMethod !== 8) {
    throw new Error(
      `Unsupported PNG zlib compression method ${compressionMethod}`,
    );
  }
  if (compressionInfo > 7) {
    throw new Error(`Unsupported PNG zlib window size flag ${compressionInfo}`);
  }
  if (checksum % 31 !== 0) {
    throw new Error("PNG zlib header check bits are invalid");
  }
  if ((flags & 32) !== 0) {
    throw new Error("PNG zlib preset dictionaries are not supported");
  }

  return compressedData.slice(2, compressedData.length - 4);
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function unfilterRow(
  encodedRow: Uint8Array,
  prevRow: Uint8Array,
  bytesPerPixel: number,
  filterType: number,
): Uint8Array {
  const row = new Uint8Array(encodedRow.length);

  for (let i = 0; i < encodedRow.length; i++) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
    const up = prevRow[i] ?? 0;
    const upLeft = i >= bytesPerPixel ? prevRow[i - bytesPerPixel] : 0;

    if (filterType === 0) {
      row[i] = encodedRow[i];
    } else if (filterType === 1) {
      row[i] = (encodedRow[i] + left) & 255;
    } else if (filterType === 2) {
      row[i] = (encodedRow[i] + up) & 255;
    } else if (filterType === 3) {
      row[i] = (encodedRow[i] + Math.floor((left + up) / 2)) & 255;
    } else if (filterType === 4) {
      row[i] = (encodedRow[i] + paethPredictor(left, up, upLeft)) & 255;
    } else {
      throw new Error(`Unsupported PNG filter type ${filterType}`);
    }
  }

  return row;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function writeRgbaPixel(
  rgba: Uint8Array,
  row: Uint8Array,
  x: number,
  y: number,
  metadata: PixelImage.PngMetadata,
  palette: Option<readonly Rgb[]>,
  transparency: Option<TransparencyData>,
): void {
  const targetOffset = (y * metadata.width + x) * 4;

  if (metadata.colorType === 3) {
    const paletteIndex = paletteIndexAt(row, x, metadata.bitDepth);
    const color = paletteColorAt(palette, paletteIndex);
    rgba[targetOffset] = color.r;
    rgba[targetOffset + 1] = color.g;
    rgba[targetOffset + 2] = color.b;
    rgba[targetOffset + 3] = transparency?.paletteAlpha?.[paletteIndex] ?? 255;
    return;
  }

  if (metadata.colorType === 6) {
    const sourceOffset = x * 4;
    rgba[targetOffset] = row[sourceOffset];
    rgba[targetOffset + 1] = row[sourceOffset + 1];
    rgba[targetOffset + 2] = row[sourceOffset + 2];
    rgba[targetOffset + 3] = row[sourceOffset + 3];
    return;
  }

  if (metadata.colorType === 4) {
    const sourceOffset = x * 2;
    const gray = row[sourceOffset];
    rgba[targetOffset] = gray;
    rgba[targetOffset + 1] = gray;
    rgba[targetOffset + 2] = gray;
    rgba[targetOffset + 3] = row[sourceOffset + 1];
    return;
  }

  if (metadata.colorType === 2) {
    const sourceOffset = x * 3;
    const transparent = transparency?.transparentRgb;
    const alpha = transparent &&
        row[sourceOffset] === transparent.r &&
        row[sourceOffset + 1] === transparent.g &&
        row[sourceOffset + 2] === transparent.b
      ? 0
      : 255;
    rgba[targetOffset] = row[sourceOffset];
    rgba[targetOffset + 1] = row[sourceOffset + 1];
    rgba[targetOffset + 2] = row[sourceOffset + 2];
    rgba[targetOffset + 3] = alpha;
    return;
  }

  const gray = row[x];
  const transparentGray = transparency?.transparentGray;
  rgba[targetOffset] = gray;
  rgba[targetOffset + 1] = gray;
  rgba[targetOffset + 2] = gray;
  rgba[targetOffset + 3] = transparentGray != null && gray === transparentGray
    ? 0
    : 255;
}

function paletteIndexAt(row: Uint8Array, x: number, bitDepth: number): number {
  if (bitDepth === 8) return row[x];

  const bitOffset = x * bitDepth;
  const byte = row[Math.floor(bitOffset / 8)];
  const shift = 8 - bitDepth - (bitOffset % 8);
  const mask = (1 << bitDepth) - 1;
  return (byte >> shift) & mask;
}

function paletteColorAt(
  palette: Option<readonly Rgb[]>,
  paletteIndex: number,
): Rgb {
  const color = palette?.[paletteIndex] ?? null;
  if (!color) {
    throw new Error(`PNG palette index ${paletteIndex} is missing from PLTE`);
  }
  return color;
}

function assertRgbaImage(image: PixelImage.RgbaImage): void {
  assertPositiveInteger(image.width, "RGBA image width");
  assertPositiveInteger(image.height, "RGBA image height");
  const expectedLength = image.width * image.height * 4;
  if (image.data.length !== expectedLength) {
    throw new Error(
      `RGBA image data length ${image.data.length} does not match ${image.width}x${image.height}`,
    );
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertAlphaThreshold(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 255) {
    throw new Error("PixelImage alpha threshold must be an integer from 1 to 255");
  }
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = asciiBytes(type);
  const output = new Uint8Array(12 + data.length);
  writeUint32(output, 0, data.length);
  output.set(typeBytes, 4);
  output.set(data, 8);
  writeUint32(
    output,
    8 + data.length,
    crc32(concatChunks([typeBytes, data])),
  );
  return output;
}

function zlibStore(data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let offset = 0; offset < data.length; offset += 65_535) {
    const block = data.slice(offset, offset + 65_535);
    const finalBlock = offset + 65_535 >= data.length ? 1 : 0;
    const length = block.length;
    const inverseLength = (~length) & 0xffff;
    chunks.push(
      new Uint8Array([
        finalBlock,
        length & 0xff,
        (length >>> 8) & 0xff,
        inverseLength & 0xff,
        (inverseLength >>> 8) & 0xff,
      ]),
      block,
    );
  }
  chunks.push(new Uint8Array(uint32Bytes(adler32(data))));
  return concatChunks(chunks);
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  // Bound each sum while postponing division until the end of a block.
  // At 5,552 bytes even an all-255 block keeps b below 2^32.
  for (let start = 0; start < data.length; start += 5_552) {
    const end = Math.min(start + 5_552, data.length);
    for (let index = start; index < end; index++) {
      a += data[index];
      b += a;
    }
    a %= 65_521;
    b %= 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of data) {
    crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n++) {
    let crc = n;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[n] = crc >>> 0;
  }
  return table;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }

  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function uint32Bytes(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    bytes[i] = value.charCodeAt(i);
  }
  return bytes;
}

function readChunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triplet = (a << 16) | (b << 8) | c;
    output += BASE64_ALPHABET[(triplet >> 18) & 63];
    output += BASE64_ALPHABET[(triplet >> 12) & 63];
    output += i + 1 < bytes.length ? BASE64_ALPHABET[(triplet >> 6) & 63] : "=";
    output += i + 2 < bytes.length ? BASE64_ALPHABET[triplet & 63] : "=";
  }
  return output;
}

function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s/g, "");
  if (clean.length % 4 !== 0) {
    throw new Error("Invalid base64 length");
  }

  let outputLength = (clean.length / 4) * 3;
  if (clean.endsWith("==")) outputLength -= 2;
  else if (clean.endsWith("=")) outputLength -= 1;

  const bytes = new Uint8Array(outputLength);
  let byteIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = decodeBase64Char(clean[i]);
    const b = decodeBase64Char(clean[i + 1]);
    const c = clean[i + 2] === "=" ? 0 : decodeBase64Char(clean[i + 2]);
    const d = clean[i + 3] === "=" ? 0 : decodeBase64Char(clean[i + 3]);
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;

    if (byteIndex < outputLength) bytes[byteIndex++] = (triplet >> 16) & 255;
    if (byteIndex < outputLength) bytes[byteIndex++] = (triplet >> 8) & 255;
    if (byteIndex < outputLength) bytes[byteIndex++] = triplet & 255;
  }
  return bytes;
}

function decodeBase64Char(char: string): number {
  const value = BASE64_ALPHABET.indexOf(char);
  if (value < 0) {
    throw new Error(`Invalid base64 character "${char}"`);
  }
  return value;
}
