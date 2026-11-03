// Pixel diff of a before/after pair. Keeps the changed regions and builds one
// side-by-side image per pair (before | after, changes outlined) for the judge.
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PairDiff {
  changedPixels: number;
  ratio: number;
  regions: Box[];
  /** before | after crop around the changes, or null when nothing changed. */
  sideBySide: string | null;
  diffImage: string | null;
}

const CELL = 24;

/** Raw RGBA, padded with white on the right and bottom to the shared canvas size. */
async function rgba(file: string, width: number, height: number): Promise<Buffer> {
  const meta = await sharp(file).metadata();
  return sharp(file)
    .ensureAlpha()
    .extend({ right: width - meta.width!, bottom: height - meta.height!, background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .raw()
    .toBuffer();
}

const DIFF_COLOR: [number, number, number] = [255, 0, 0];

export async function diffPair(beforeFile: string, afterFile: string, outBase: string): Promise<PairDiff> {
  const [bm, am] = await Promise.all([sharp(beforeFile).metadata(), sharp(afterFile).metadata()]);
  const width = Math.max(bm.width!, am.width!);
  const height = Math.max(bm.height!, am.height!);
  const [b, a] = await Promise.all([rgba(beforeFile, width, height), rgba(afterFile, width, height)]);
  const out = Buffer.alloc(width * height * 4);
  const changedPixels = pixelmatch(b, a, out, width, height, { threshold: 0.1, includeAA: false, diffColor: DIFF_COLOR, diffColorAlt: DIFF_COLOR, aaColor: [255, 255, 0] });
  if (changedPixels === 0) return { changedPixels, ratio: 0, regions: [], sideBySide: null, diffImage: null };

  const regions = regionsFrom(out, width, height);
  const diffImage = `${outBase}.diff.png`;
  await sharp(out, { raw: { width, height, channels: 4 } }).png().toFile(diffImage);

  // Crop to the changes with some context, so the judge sees them at full size.
  const pad = 120;
  const top = Math.max(0, Math.min(...regions.map((r) => r.y)) - pad);
  const bottom = Math.min(height, Math.max(...regions.map((r) => r.y + r.h)) + pad);
  const cropH = Math.min(bottom - top, 2400);
  // Two passes: sharp crops before it composites within one pipeline.
  const outline = async (img: Buffer) => {
    const boxed = await sharp(img, { raw: { width, height, channels: 4 } })
      .composite([{ input: Buffer.from(svgBoxes(regions, width, height)), top: 0, left: 0 }])
      .png()
      .toBuffer();
    return sharp(boxed).extract({ left: 0, top, width, height: cropH }).png().toBuffer();
  };
  const [bc, ac] = await Promise.all([outline(b), outline(a)]);
  const gap = 16;
  const sideBySide = `${outBase}.side.png`;
  await sharp({ create: { width: width * 2 + gap, height: cropH, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 1 } } })
    .composite([
      { input: bc, left: 0, top: 0 },
      { input: ac, left: width + gap, top: 0 },
    ])
    .png()
    .toFile(sideBySide);

  return { changedPixels, ratio: changedPixels / (width * height), regions, sideBySide, diffImage };
}

/** Groups changed pixels into boxes: mark changed grid cells, then join touching cells. */
export function regionsFrom(diff: Buffer, width: number, height: number): Box[] {
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const hot = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Counted differences are painted pure red; anti-aliasing is yellow and the rest faded gray.
      if (diff[i] === 255 && diff[i + 1] === 0 && diff[i + 2] === 0) hot[Math.floor(y / CELL) * cols + Math.floor(x / CELL)] = 1;
    }
  }
  const seen = new Uint8Array(cols * rows);
  const boxes: Box[] = [];
  for (let start = 0; start < hot.length; start++) {
    if (!hot[start] || seen[start]) continue;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % cols, cy = Math.floor(c / cols);
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const n = ny * cols + nx;
          if (hot[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    boxes.push({
      x: minX * CELL,
      y: minY * CELL,
      w: Math.min(width, (maxX + 1) * CELL) - minX * CELL,
      h: Math.min(height, (maxY + 1) * CELL) - minY * CELL,
    });
  }
  return boxes.sort((p, q) => p.y - q.y || p.x - q.x);
}

function svgBoxes(boxes: Box[], width: number, height: number): string {
  const rects = boxes
    .map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="#ff2d55" stroke-width="3"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`;
}
