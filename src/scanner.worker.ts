/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import jsQR from 'jsqr';

function isValidPacket(buffer: Uint8Array): boolean {
  if (!buffer || buffer.length < 20) return false;
  if (buffer[0] !== 71 || buffer[1] !== 81 || buffer[2] !== 82) return false; // 'GQR'
  
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const checksum = view.getUint16(18, true);
  const payload = buffer.subarray(20);
  
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload[i];
    hash = (hash * 0x01000193) >>> 0;
  }
  const calcChecksum = ((hash ^ (hash >>> 16)) & 0xffff);
  return calcChecksum === checksum;
}

self.onmessage = function (e) {
  try {
    const { imgDataBuffer, w, h } = e.data;
    const imgData = new Uint8ClampedArray(imgDataBuffer);
    
    // 1. Grayscale First
    const grayData = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const idx = i * 4;
      const r = imgData[idx];
      const g = imgData[idx + 1];
      const b = imgData[idx + 2];
      const a = imgData[idx + 3];
      
      const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      grayData[idx] = gray;
      grayData[idx + 1] = gray;
      grayData[idx + 2] = gray;
      grayData[idx + 3] = a;
    }
    
    const grayScan = jsQR(grayData, w, h);
    if (grayScan && grayScan.binaryData) {
      const grayBytes = new Uint8Array(grayScan.binaryData);
      if (isValidPacket(grayBytes)) {
        self.postMessage({
          rPayload: grayBytes,
          gPayload: grayBytes,
          bPayload: grayBytes,
        });
        return;
      }
    }
    
    // 2. Fallback to Color Cross-talk compensation
    const rData = new Uint8ClampedArray(w * h * 4);
    const gData = new Uint8ClampedArray(w * h * 4);
    const bData = new Uint8ClampedArray(w * h * 4);

    for (let i = 0; i < w * h; i++) {
      const idx = i * 4;
      const r = imgData[idx];
      const g = imgData[idx + 1];
      const b = imgData[idx + 2];
      const a = imgData[idx + 3];

      let rClean = r - 0.4 * Math.max(0, g - r) - 0.4 * Math.max(0, b - r);
      if (rClean < 0) rClean = 0; else if (rClean > 255) rClean = 255;

      let gClean = g - 0.4 * Math.max(0, r - g) - 0.4 * Math.max(0, b - g);
      if (gClean < 0) gClean = 0; else if (gClean > 255) gClean = 255;

      let bClean = b - 0.4 * Math.max(0, r - b) - 0.4 * Math.max(0, g - b);
      if (bClean < 0) bClean = 0; else if (bClean > 255) bClean = 255;

      rData[idx] = rClean; rData[idx + 1] = rClean; rData[idx + 2] = rClean; rData[idx + 3] = a;
      gData[idx] = gClean; gData[idx + 1] = gClean; gData[idx + 2] = gClean; gData[idx + 3] = a;
      bData[idx] = bClean; bData[idx + 1] = bClean; bData[idx + 2] = bClean; bData[idx + 3] = a;
    }

    const rScan = jsQR(rData, w, h);
    const gScan = jsQR(gData, w, h);
    const bScan = jsQR(bData, w, h);

    const rBytes = rScan && rScan.binaryData ? new Uint8Array(rScan.binaryData) : null;
    const gBytes = gScan && gScan.binaryData ? new Uint8Array(gScan.binaryData) : null;
    const bBytes = bScan && bScan.binaryData ? new Uint8Array(bScan.binaryData) : null;

    self.postMessage({
      rPayload: rBytes && isValidPacket(rBytes) ? rBytes : null,
      gPayload: gBytes && isValidPacket(gBytes) ? gBytes : null,
      bPayload: bBytes && isValidPacket(bBytes) ? bBytes : null,
    });
  } catch (err: any) {
    self.postMessage({ error: err.message });
  }
};
