// ─────────────────────────────────────────────────────────────
// Shared Media & URL Utilities
// ─────────────────────────────────────────────────────────────
import { execFile } from "child_process";
import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import logger from "./logger.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
// ── ffmpeg availability (cached per process) ────────────────
let _ffmpegAvailable = null;
async function isFfmpegAvailable() {
    if (_ffmpegAvailable !== null)
        return _ffmpegAvailable;
    return new Promise((resolve) => {
        execFile("ffmpeg", ["-version"], { timeout: 5_000 }, (error) => {
            _ffmpegAvailable = !error;
            if (!_ffmpegAvailable) {
                logger.warn("[media] ffmpeg not found on PATH — GIF animation and video frame extraction will be degraded");
            }
            resolve(_ffmpegAvailable);
        });
    });
}
// ── Provider Image Limits ───────────────────────────────────
/** Anthropic's per-image inline base64 limit. */
const ANTHROPIC_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
/**
 * Maximum pixel dimension (width or height) for images sent to providers.
 * Anthropic hard-rejects >8000px, but most vision models gain little
 * beyond ~1500px. Capping at 2000px saves bandwidth, memory, and tokens
 * while preserving enough detail for accurate captioning/analysis.
 */
const MAX_IMAGE_DIMENSION = 2000;
/**
 * Compress a base64-encoded image to fit within a byte-size limit.
 *
 * Strategy:
 *  - GIFs → ffmpeg resize (preserves animation for models that support it)
 *  - Everything else → sharp JPEG conversion + progressive downscale
 */
export async function compressImageForSizeLimit(base64Data, mediaType, maxBytes = ANTHROPIC_IMAGE_MAX_BYTES) {
    try {
        // Step 0: enforce pixel dimension limits first (avoids sending oversized pixels)
        const dimensionResult = await constrainImageDimensions(base64Data, mediaType);
        base64Data = dimensionResult.data;
        mediaType = dimensionResult.mediaType;
        // Anthropic measures the base64 STRING length, not decoded binary size
        const rawBytes = base64Data.length;
        if (rawBytes <= maxBytes) {
            return { data: base64Data, mediaType };
        }
        const sizeMB = (rawBytes / 1024 / 1024).toFixed(2);
        const limitMB = (maxBytes / 1024 / 1024).toFixed(0);
        logger.info(`[media] Image exceeds ${limitMB} MB limit (${sizeMB} MB, ${mediaType}). Compressing...`);
        // GIFs → ffmpeg (preserves animation)
        if (mediaType === "image/gif") {
            return await compressGifWithFfmpeg(base64Data, maxBytes);
        }
        // Everything else → sharp (converts to JPEG)
        return await compressWithSharp(base64Data, maxBytes);
    }
    catch (error) {
        logger.warn(`[media] Image compression failed (${error instanceof Error ? getErrorMessage(error) : String(error)}), returning original data`);
        return { data: base64Data, mediaType };
    }
}
/**
 * Constrain image pixel dimensions to MAX_IMAGE_DIMENSION.
 * If either width or height exceeds the limit, the image is downscaled
 * proportionally using sharp's Lanczos3 resampler.
 *
 * GIFs are skipped (ffmpeg handles them separately in byte-size compression).
 */
export async function constrainImageDimensions(base64Data, mediaType, maxDim = MAX_IMAGE_DIMENSION) {
    // GIFs are animated — skip (ffmpeg handles them in compressGifWithFfmpeg)
    if (mediaType === "image/gif") {
        return { data: base64Data, mediaType };
    }
    try {
        const buffer = Buffer.from(base64Data, "base64");
        const metadata = await sharp(buffer).metadata();
        const { width, height } = metadata;
        if (!width || !height || (width <= maxDim && height <= maxDim)) {
            return { data: base64Data, mediaType };
        }
        // Calculate scale factor to fit within maxDim on the longest axis
        const scale = maxDim / Math.max(width, height);
        const newWidth = Math.round(width * scale);
        const newHeight = Math.round(height * scale);
        logger.info(`[media] Image dimensions ${width}×${height} exceed ${maxDim}px limit. ` +
            `Resizing to ${newWidth}×${newHeight}...`);
        // Preserve original format when possible, fall back to JPEG
        let pipeline = sharp(buffer).resize(newWidth, newHeight, {
            fit: "inside",
            withoutEnlargement: true,
        });
        let outputMime = mediaType;
        if (mediaType === "image/png") {
            pipeline = pipeline.png();
        }
        else if (mediaType === "image/webp") {
            pipeline = pipeline.webp();
        }
        else {
            // JPEG for everything else (bmp, tiff, avif, any)
            pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true });
            outputMime = "image/jpeg";
        }
        const resized = await pipeline.toBuffer();
        const resizedB64 = resized.toString("base64");
        logger.info(`[media] Dimension-constrained: ${width}×${height} → ${newWidth}×${newHeight} ` +
            `(${(resizedB64.length / 1024 / 1024).toFixed(2)} MB b64)`);
        return { data: resizedB64, mediaType: outputMime };
    }
    catch (error) {
        logger.warn(`[media] Dimension check failed (${error instanceof Error ? getErrorMessage(error) : String(error)}), passing through`);
        return { data: base64Data, mediaType };
    }
}
/**
 * Compress an animated GIF using ffmpeg's scale filter.
 * Preserves animation — progressively halves dimensions until under limit.
 */
async function compressGifWithFfmpeg(base64Data, maxBytes) {
    // ── Graceful degradation: if ffmpeg is not installed, convert the
    //    first frame to a static JPEG via sharp instead of crashing.
    const hasFfmpeg = await isFfmpegAvailable();
    if (!hasFfmpeg) {
        logger.warn("[media] ffmpeg unavailable — converting GIF to static JPEG via sharp");
        return compressWithSharp(base64Data, maxBytes);
    }
    let temporaryDirectory = null;
    try {
        temporaryDirectory = await mkdtemp(join(tmpdir(), "prism-gif-"));
        const inputPath = join(temporaryDirectory, "input.gif");
        const buffer = Buffer.from(base64Data, "base64");
        await writeFile(inputPath, buffer);
        // Progressive resize: 75% → 56% → 42% → 32% → 24% → 18% of original
        const scaleFactors = [0.75, 0.75, 0.75, 0.75, 0.75, 0.75];
        let cumulativeScale = 1;
        for (const factor of scaleFactors) {
            cumulativeScale *= factor;
            const outputPath = join(temporaryDirectory, `output_${Math.round(cumulativeScale * 100)}.gif`);
            await new Promise((resolve, reject) => {
                execFile("ffmpeg", [
                    "-y",
                    "-i",
                    inputPath,
                    "-vf",
                    `scale='iw*${cumulativeScale}:ih*${cumulativeScale}':flags=lanczos`,
                    "-gifflags",
                    "+transdiff",
                    outputPath,
                ], { timeout: 30_000 }, (error, _stdout, stderr) => {
                    if (error)
                        reject(new Error(`ffmpeg GIF resize failed: ${stderr?.toString().slice(-200) || error.message}`));
                    else
                        resolve();
                });
            });
            const result = await readFile(outputPath);
            const resultB64 = result.toString("base64");
            if (resultB64.length <= maxBytes) {
                logger.info(`[media] GIF compressed to ${(resultB64.length / 1024 / 1024).toFixed(2)} MB b64 ` +
                    `(scale=${Math.round(cumulativeScale * 100)}%)`);
                return {
                    data: resultB64,
                    mediaType: "image/gif",
                };
            }
        }
        // Final fallback: tiny GIF
        const fallbackPath = join(temporaryDirectory, "output_fallback.gif");
        await new Promise((resolve, reject) => {
            execFile("ffmpeg", [
                "-y",
                "-i",
                inputPath,
                "-vf",
                "scale='min(512,iw):min(512,ih)':force_original_aspect_ratio=decrease:flags=lanczos",
                "-gifflags",
                "+transdiff",
                fallbackPath,
            ], { timeout: 30_000 }, (error, _stdout, stderr) => {
                if (error)
                    reject(new Error(`ffmpeg GIF fallback resize failed: ${stderr?.toString().slice(-200) || error.message}`));
                else
                    resolve();
            });
        });
        const fallback = await readFile(fallbackPath);
        const fallbackB64 = fallback.toString("base64");
        logger.warn(`[media] GIF aggressive fallback: ${(fallbackB64.length / 1024 / 1024).toFixed(2)} MB b64 (512px max)`);
        return {
            data: fallbackB64,
            mediaType: "image/gif",
        };
    }
    catch (error) {
        logger.warn(`[media] ffmpeg GIF compression failed (${error instanceof Error ? getErrorMessage(error) : String(error)}), falling back to static JPEG via sharp`);
        return compressWithSharp(base64Data, maxBytes);
    }
    finally {
        if (temporaryDirectory) {
            rm(temporaryDirectory, { recursive: true, force: true }).catch(() => { });
        }
    }
}
/**
 * Compress a non-GIF image using sharp.
 * Converts to JPEG with progressive quality + dimension reduction.
 */
async function compressWithSharp(base64Data, maxBytes) {
    let buffer = Buffer.from(base64Data, "base64");
    const qualitySteps = [85, 70, 50];
    // Step 1: try quality reduction (convert to JPEG)
    for (const quality of qualitySteps) {
        const compressed = await sharp(buffer)
            .jpeg({ quality, mozjpeg: true })
            .toBuffer();
        const compressedB64 = compressed.toString("base64");
        if (compressedB64.length <= maxBytes) {
            logger.info(`[media] Compressed to ${(compressedB64.length / 1024 / 1024).toFixed(2)} MB b64 ` +
                `(JPEG q=${quality})`);
            return {
                data: compressedB64,
                mediaType: "image/jpeg",
            };
        }
        buffer = Buffer.from(compressed);
    }
    // Step 2: progressive resize (shrink by 25% each iteration)
    const metadata = await sharp(buffer).metadata();
    let width = metadata.width || 0;
    let height = metadata.height || 0;
    for (let i = 0; i < 6; i++) {
        width = Math.round(width * 0.75);
        height = Math.round(height * 0.75);
        const resized = await sharp(Buffer.from(base64Data, "base64"))
            .resize(width, height, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 70, mozjpeg: true })
            .toBuffer();
        const resizedB64 = resized.toString("base64");
        if (resizedB64.length <= maxBytes) {
            logger.info(`[media] Compressed to ${(resizedB64.length / 1024 / 1024).toFixed(2)} MB b64 ` +
                `(${width}x${height}, JPEG q=70)`);
            return {
                data: resizedB64,
                mediaType: "image/jpeg",
            };
        }
    }
    // Final fallback: aggressive resize
    const fallback = await sharp(Buffer.from(base64Data, "base64"))
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 50, mozjpeg: true })
        .toBuffer();
    const fallbackB64 = fallback.toString("base64");
    logger.warn(`[media] Aggressive fallback: ${(fallbackB64.length / 1024 / 1024).toFixed(2)} MB b64 (1024px, q=50)`);
    return {
        data: fallbackB64,
        mediaType: "image/jpeg",
    };
}
export function getDataUrlMimeType(dataUrl) {
    const match = dataUrl.match(/^data:([^;]+);base64,/);
    return match ? match[1] : null;
}
export function getUrlType(url) {
    if (url.startsWith("data:"))
        return "data";
    if (url.startsWith("http://") || url.startsWith("https://"))
        return "http";
    return "any";
}
export function inferMimeFromUrl(url) {
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        if (/\.(png|jpg|jpeg|gif|webp|bmp|svg|avif)$/i.test(pathname))
            return "image";
        if (/\.pdf$/i.test(pathname))
            return "pdf";
        if (/\.(txt|md|csv|json|xml|html|css|js|ts)$/i.test(pathname))
            return "text";
    }
    catch {
        /* ignore */
    }
    return "any";
}
// ── Video Frame Extraction ──────────────────────────────────
/**
 * Extract frames from a video data URL using ffmpeg.
 * Returns an array of JPEG image data URLs (one per frame at 1fps).
 *
 * Each image frame costs ~256 tokens in vision models. Default maxFrames=8
 * keeps total image tokens ~2K, leaving room for text generation in
 * local models with limited context windows (4K-8K typical).
 */
export async function extractVideoFrames(videoDataUrl, options = {}) {
    const { fps = 1, maxFrames = 8, quality = 5 } = options;
    // ── Graceful degradation: fail fast if ffmpeg is not installed
    const hasFfmpeg = await isFfmpegAvailable();
    if (!hasFfmpeg) {
        throw new Error("ffmpeg is not installed — video frame extraction requires ffmpeg. " +
            "Install it with: apt install ffmpeg");
    }
    let temporaryDirectory = null;
    try {
        // Decode video data URL to a temp file.
        // Use string ops instead of regex — regex (.+) on multi-MB base64 causes OOM.
        const b64Marker = ";base64,";
        const markerIndex = videoDataUrl.indexOf(b64Marker);
        if (markerIndex === -1 || !videoDataUrl.startsWith("data:")) {
            throw new Error("Invalid video data URL format");
        }
        const mime = videoDataUrl.slice(5, markerIndex); // "data:" is 5 chars
        const base64Data = videoDataUrl.slice(markerIndex + b64Marker.length);
        const ext = mime.split("/")[1]?.split(";")[0] || "mp4";
        temporaryDirectory = await mkdtemp(join(tmpdir(), "prism-frames-"));
        const inputPath = join(temporaryDirectory, `input.${ext}`);
        const outputPattern = join(temporaryDirectory, "frame_%04d.jpg");
        // Write video to temp file
        const videoBuffer = Buffer.from(base64Data, "base64");
        const fileSizeMB = (videoBuffer.length / (1024 * 1024)).toFixed(1);
        logger.info(`[media] Writing ${fileSizeMB} MB video (${mime}) to ${inputPath}`);
        await writeFile(inputPath, videoBuffer);
        // Extract frames with ffmpeg
        const ffmpegStderr = await new Promise((resolve, reject) => {
            execFile("ffmpeg", [
                "-i",
                inputPath,
                "-vf",
                `fps=${fps}`,
                "-vframes",
                String(maxFrames),
                "-q:v",
                String(quality),
                "-f",
                "image2",
                outputPattern,
            ], { timeout: 30_000 }, (error, _stdout, stderr) => {
                if (error) {
                    reject(new Error(`ffmpeg failed (${fileSizeMB} MB ${ext}): ${stderr?.toString().slice(-200) || error.message}`));
                }
                else {
                    resolve(stderr?.toString() || "");
                }
            });
        });
        // Read extracted frames and convert to data URLs
        const frames = [];
        for (let i = 1; i <= maxFrames; i++) {
            const framePath = join(temporaryDirectory, `frame_${String(i).padStart(4, "0")}.jpg`);
            try {
                const frameBuffer = await readFile(framePath);
                const frameBase64 = frameBuffer.toString("base64");
                frames.push(`data:image/jpeg;base64,${frameBase64}`);
            }
            catch {
                break;
            }
        }
        if (frames.length === 0) {
            // ffmpeg ran but produced no frames — extract error details
            const durationMatch = ffmpegStderr?.match(/Duration: ([^,]+)/);
            const duration = durationMatch?.[1] || "any";
            throw new Error(`ffmpeg produced 0 frames from ${fileSizeMB} MB ${ext} video (duration: ${duration}). ` +
                `The file may be corrupt, use an unsupported codec, or contain no video stream.`);
        }
        logger.info(`[media] Extracted ${frames.length} frames from video (${ext}, ${fileSizeMB} MB, fps=${fps})`);
        return frames;
    }
    finally {
        if (temporaryDirectory) {
            rm(temporaryDirectory, { recursive: true, force: true }).catch(() => { });
        }
    }
}
//# sourceMappingURL=media.js.map