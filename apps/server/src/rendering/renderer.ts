import sharp from 'sharp';
import { dimensions, type VideoSettings } from '../../../../packages/contracts/src/index.js';
import { AppError, assert } from '../errors.js';

sharp.cache({ memory: 64, files: 8, items: 32 });
sharp.concurrency(1);
export const RENDERER_VERSION = '1.0.0';
export async function validateImage(path: string, maxPixels: number) {
  try {
    const meta = await sharp(path, { limitInputPixels: maxPixels, animated: true })
      .timeout({ seconds: 10 })
      .metadata();
    assert(
      meta.width && meta.height,
      'IMAGE_DECODE_FAILED',
      'Ảnh không có kích thước hợp lệ.',
      422,
    );
    assert(
      ['png', 'jpeg', 'webp'].includes(meta.format ?? ''),
      'UNSUPPORTED_FORMAT',
      'Chỉ hỗ trợ PNG, JPEG và WebP tĩnh.',
      422,
    );
    assert((meta.pages ?? 1) === 1, 'UNSUPPORTED_FORMAT', 'Ảnh động không được hỗ trợ.', 422);
    // Full decode catches truncated images; stats does not materialize RGBA in JS.
    await sharp(path, { limitInputPixels: maxPixels, failOn: 'warning' })
      .timeout({ seconds: 60 })
      .stats();
    return {
      width: meta.width,
      height: meta.height,
      format: meta.format as 'png' | 'jpeg' | 'webp',
      orientation: meta.orientation ?? 1,
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      'IMAGE_DECODE_FAILED',
      'Không thể giải mã ảnh hoặc ảnh vượt giới hạn pixel.',
      422,
    );
  }
}
export async function renderFrame(
  path: string,
  video: VideoSettings,
  maxPixels: number,
  mode: 'interactive' | 'output-check' = 'output-check',
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const full = dimensions(video);
  const factor = mode === 'interactive' ? Math.min(1, 960 / Math.max(full.width, full.height)) : 1;
  const width = Math.round(full.width * factor),
    height = Math.round(full.height * factor);
  const base = sharp(path, { limitInputPixels: maxPixels })
    .autoOrient()
    .toColourspace('srgb')
    .flatten({ background: video.background.matteColor });
  let background: Buffer;
  if (video.background.mode === 'solid') {
    background = await sharp({
      create: { width, height, channels: 4, background: video.background.matteColor },
    })
      .png()
      .toBuffer();
  } else {
    const scale = Math.min(1, 960 / Math.max(width, height));
    const bw = Math.max(1, Math.round(width * scale)),
      bh = Math.max(1, Math.round(height * scale));
    let bg = base.clone().resize(bw, bh, { fit: 'cover', position: 'centre' });
    const sigma = (video.background.blurStrength / 30) * 24 * (Math.max(bw, bh) / 960);
    if (sigma > 0) bg = bg.blur(Math.max(0.3, sigma));
    const small = await bg.linear(video.background.brightness, 0).png().toBuffer();
    background = await sharp(small).resize(width, height, { fit: 'fill' }).png().toBuffer();
  }
  signal?.throwIfAborted();
  const fg = await base
    .clone()
    .resize(width, height, { fit: 'inside', kernel: 'lanczos3' })
    .png()
    .toBuffer();
  signal?.throwIfAborted();
  const { data, info } = await sharp(background)
    .composite([{ input: fg, gravity: 'centre' }])
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert(
    info.channels === 4 && data.length === width * height * 4,
    'RENDER_FAILED',
    'Buffer render không hợp lệ.',
    500,
  );
  return { data, width, height };
}
export async function framePNG(frame: Awaited<ReturnType<typeof renderFrame>>) {
  return sharp(frame.data, { raw: { width: frame.width, height: frame.height, channels: 4 } })
    .png()
    .toBuffer();
}
