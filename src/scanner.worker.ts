/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import jsQR from 'jsqr';

self.onmessage = function (e) {
  try {
    const { imgDataBuffer, w, h } = e.data;
    const imgData = new Uint8ClampedArray(imgDataBuffer);
    
    // 1. Grayscale First (for monochrome mode)
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
    if (grayScan && grayScan.data) {
      // Validate this looks like a Base64 GQR packet before using grayscale shortcut
      const grayStr = grayScan.data;
      if (grayStr.length > 20) {
        self.postMessage({
          rPayload: grayStr,
          gPayload: grayStr,
          bPayload: grayStr,
        });
        return;
      }
    }
    
    // 2. Fallback to per-channel separation for color mode
    const rData = new Uint8ClampedArray(w * h * 4);
    const gData = new Uint8ClampedArray(w * h * 4);
    const bData = new Uint8ClampedArray(w * h * 4);

    for (let i = 0; i < w * h; i++) {
      const idx = i * 4;
      const r = imgData[idx];
      const g = imgData[idx + 1];
      const b = imgData[idx + 2];
      const a = imgData[idx + 3];

      // Red Channel Monochromatic map
      rData[idx] = r; rData[idx + 1] = r; rData[idx + 2] = r; rData[idx + 3] = a;
      // Green Channel Monochromatic map
      gData[idx] = g; gData[idx + 1] = g; gData[idx + 2] = g; gData[idx + 3] = a;
      // Blue Channel Monochromatic map
      bData[idx] = b; bData[idx + 1] = b; bData[idx + 2] = b; bData[idx + 3] = a;
    }

    const rScan = jsQR(rData, w, h);
    const gScan = jsQR(gData, w, h);
    const bScan = jsQR(bData, w, h);

    self.postMessage({
      rPayload: rScan ? rScan.data : null,
      gPayload: gScan ? gScan.data : null,
      bPayload: bScan ? bScan.data : null,
    });
  } catch (err: any) {
    self.postMessage({ error: err.message });
  }
};
