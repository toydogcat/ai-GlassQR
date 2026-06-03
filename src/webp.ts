/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Helper to write string to Uint8Array
function writeString(arr: Uint8Array, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    arr[offset + i] = str.charCodeAt(i);
  }
}

// Helper to read string from Uint8Array
function readString(arr: Uint8Array, offset: number, length: number): string {
  let str = '';
  for (let i = 0; i < length; i++) {
    str += String.fromCharCode(arr[offset + i]);
  }
  return str;
}

// Helper to write Uint32 little-endian
function writeUint32(arr: Uint8Array, offset: number, value: number) {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >> 8) & 0xff;
  arr[offset + 2] = (value >> 16) & 0xff;
  arr[offset + 3] = (value >> 24) & 0xff;
}

// Helper to read Uint32 little-endian
function readUint32(arr: Uint8Array, offset: number): number {
  return (
    arr[offset] |
    (arr[offset + 1] << 8) |
    (arr[offset + 2] << 16) |
    (arr[offset + 3] << 24)
  ) >>> 0;
}

// Helper to write Uint24 little-endian
function writeUint24(arr: Uint8Array, offset: number, value: number) {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >> 8) & 0xff;
  arr[offset + 2] = (value >> 16) & 0xff;
}

// Helper to read Uint24 little-endian
function readUint24(arr: Uint8Array, offset: number): number {
  return arr[offset] | (arr[offset + 1] << 8) | (arr[offset + 2] << 16);
}

// Helper to write Uint16 little-endian
function writeUint16(arr: Uint8Array, offset: number, value: number) {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >> 8) & 0xff;
}

interface WebPFrameInfo {
  tag: string;
  payload: Uint8Array;
}

// Extract image data chunk (VP8 / VP8L) from a standalone WebP file
function extractImageChunk(webpBytes: Uint8Array): WebPFrameInfo | null {
  if (readString(webpBytes, 0, 4) !== 'RIFF') return null;
  if (readString(webpBytes, 8, 4) !== 'WEBP') return null;

  let offset = 12;
  const length = webpBytes.length;

  while (offset < length - 8) {
    const chunkTag = readString(webpBytes, offset, 4);
    const chunkSize = readUint32(webpBytes, offset + 4);
    
    // Chunk size is followed by data.
    // Chunks are padded to even number of bytes by RIFF spec
    const totalChunkBytes = chunkSize + (chunkSize % 2);

    if (chunkTag === 'VP8 ' || chunkTag === 'VP8L') {
      // Return the tag and the complete chunk (tag, size, payload)
      // Since RIFF padding is not included in chunk size but added at end, let's copy the chunk payload
      const payloadStart = offset + 8;
      const payloadEnd = Math.min(payloadStart + chunkSize, length);
      return {
        tag: chunkTag,
        payload: webpBytes.slice(payloadStart, payloadEnd)
      };
    }
    
    offset += 8 + totalChunkBytes;
  }

  return null;
}

/**
 * Packs multiple standalone WebP frame buffers into a standards-compliant Animated WebP Blob.
 * 
 * @param frameWebpBuffers List of standalone WebP images as Uint8Array (typically lossless VP8L or lossy VP8)
 * @param width The width of the animation canvas
 * @param height The height of the animation canvas
 * @param frameDurationMs Duration of each frame in milliseconds
 * @returns Animated WebP Blob
 */
export function buildAnimatedWebP(
  frameWebpBuffers: Uint8Array[],
  width: number,
  height: number,
  frameDurationMs: number
): Blob {
  const chunks: Uint8Array[] = [];

  // VP8X Header chunk (10 bytes size)
  // Flags: 0x02 = Animation
  // Width: Canvas width minus 1 (3 bytes)
  // Height: Canvas height minus 1 (3 bytes)
  const vp8xChunk = new Uint8Array(18);
  writeString(vp8xChunk, 0, 'VP8X');
  writeUint32(vp8xChunk, 4, 10); // chunk size
  vp8xChunk[8] = 0x02; // animation flag set
  vp8xChunk[9] = 0; // reserved
  vp8xChunk[10] = 0; // reserved
  vp8xChunk[11] = 0; // reserved
  writeUint24(vp8xChunk, 12, width - 1);
  writeUint24(vp8xChunk, 15, height - 1);
  chunks.push(vp8xChunk);

  // ANIM Header chunk (6 bytes size)
  // BgColor: 0,0,0,0 (Blue, Green, Red, Alpha)
  // Loopcount: 0 (Infinite)
  const animChunk = new Uint8Array(14);
  writeString(animChunk, 0, 'ANIM');
  writeUint32(animChunk, 4, 6); // chunk size
  animChunk[8] = 0; // Blue
  animChunk[9] = 0; // Green
  animChunk[10] = 0; // Red
  animChunk[11] = 0; // Alpha
  writeUint16(animChunk, 12, 0); // Loop count 0
  chunks.push(animChunk);

  // Extract VP8/VP8L chunks from each input standalone WebP and wrap as ANMF chunks
  for (let i = 0; i < frameWebpBuffers.length; i++) {
    const frameData = extractImageChunk(frameWebpBuffers[i]);
    if (!frameData) {
      console.warn(`Skipping invalid frame ${i} as it lacks standard WebP chunk structures.`);
      continue;
    }

    const imagePayload = frameData.payload;
    const padding = imagePayload.length % 2;
    const totalImageChunkSize = 8 + imagePayload.length + padding;

    // ANMF chunk size = 16 bytes frame parameters + dynamic image chunk size
    const anmfPayloadSize = 16 + totalImageChunkSize;
    const anmfHeader = new Uint8Array(24); // Tag (4) + Size (4) + FrameX/Y/W/H/Duration/Flags (16)
    
    writeString(anmfHeader, 0, 'ANMF');
    writeUint32(anmfHeader, 4, anmfPayloadSize);
    writeUint24(anmfHeader, 8, 0); // FrameX = 0
    writeUint24(anmfHeader, 11, 0); // FrameY = 0
    writeUint24(anmfHeader, 14, width - 1); // Width
    writeUint24(anmfHeader, 17, height - 1); // Height
    writeUint24(anmfHeader, 20, frameDurationMs); // Duration in ms
    anmfHeader[23] = 0x03; // Blend method: Overwrite (0x02) | Disposal: Do not dispose. Bitwise 0x03 is standard for overwrite.

    // Concatenate bits for this complete ANMF chunk
    const innerImageChunk = new Uint8Array(totalImageChunkSize);
    writeString(innerImageChunk, 0, frameData.tag);
    writeUint32(innerImageChunk, 4, imagePayload.length);
    innerImageChunk.set(imagePayload, 8);
    if (padding > 0) {
      innerImageChunk[8 + imagePayload.length] = 0; // RIFF padding
    }

    const fullAnmfChunk = new Uint8Array(anmfHeader.length + innerImageChunk.length);
    fullAnmfChunk.set(anmfHeader, 0);
    fullAnmfChunk.set(innerImageChunk, anmfHeader.length);

    chunks.push(fullAnmfChunk);
  }

  // Calculate total final RIFF container size
  let chunksSize = 4; // for 'WEBP'
  for (const chunk of chunks) {
    chunksSize += chunk.length;
  }

  const riffHeader = new Uint8Array(12);
  writeString(riffHeader, 0, 'RIFF');
  writeUint32(riffHeader, 4, chunksSize);
  writeString(riffHeader, 8, 'WEBP');

  // Build the complete combined array
  const fullBytes = new Uint8Array(12 + chunksSize - 4);
  fullBytes.set(riffHeader, 0);
  
  let currentOffset = 12;
  for (const chunk of chunks) {
    fullBytes.set(chunk, currentOffset);
    currentOffset += chunk.length;
  }

  return new Blob([fullBytes], { type: 'image/webp' });
}

interface SplitFrame {
  dataUrl: string;
  durationMs: number;
}

/**
 * Parses an Animated WebP file, extracts individual frames, wraps them into standalone WebPs,
 * and creates Blob URLs suitable for standard HTMLImageElement loading.
 */
export function demuxAnimatedWebP(webpBytes: Uint8Array): SplitFrame[] {
  if (readString(webpBytes, 0, 4) !== 'RIFF') {
    throw new Error('Not a valid RIFF file container');
  }
  if (readString(webpBytes, 8, 4) !== 'WEBP') {
    throw new Error('Not a valid WEBP image');
  }

  const frames: SplitFrame[] = [];
  let offset = 12;
  const length = webpBytes.length;

  while (offset < length - 8) {
    const chunkTag = readString(webpBytes, offset, 4);
    const chunkSize = readUint32(webpBytes, offset + 4);
    const paddedChunkSize = chunkSize + (chunkSize % 2);

    if (chunkTag === 'ANMF') {
      // ANMF metadata is 16 bytes
      const durationMs = readUint24(webpBytes, offset + 20);

      // Extract image chunk from inside ANMF
      const innerImageOffset = offset + 8 + 16;
      let innerImageTag = readString(webpBytes, innerImageOffset, 4);
      let innerImageSize = readUint32(webpBytes, innerImageOffset + 4);

      if (innerImageTag === 'VP8 ' || innerImageTag === 'VP8L') {
        const imagePayloadStart = innerImageOffset + 8;
        const imagePayload = webpBytes.slice(imagePayloadStart, imagePayloadStart + innerImageSize);

        // Package as a standalone single-frame WebP
        const standaloneRiff = new Uint8Array(20 + imagePayload.length + (imagePayload.length % 2));
        writeString(standaloneRiff, 0, 'RIFF');
        writeUint32(standaloneRiff, 4, 12 + imagePayload.length);
        writeString(standaloneRiff, 8, 'WEBP');
        writeString(standaloneRiff, 12, innerImageTag);
        writeUint32(standaloneRiff, 16, imagePayload.length);
        standaloneRiff.set(imagePayload, 20);

        const blob = new Blob([standaloneRiff], { type: 'image/webp' });
        const dataUrl = URL.createObjectURL(blob);
        frames.push({
          dataUrl,
          durationMs,
        });
      }
    }

    offset += 8 + paddedChunkSize;
  }

  return frames;
}
