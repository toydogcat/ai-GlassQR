/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface FileMetadata {
  id: number;
  name: string;
  size: number;
  type: string;
  totalBlocks: number;
  blockSize: number;
}

export interface FountainPacket {
  fileId: number;
  seq: number;
  totalBlocks: number;
  originalSize: number;
  blockSize: number;
  checksum: number; // Simple checksum of payload
  payload: Uint8Array;
}

export interface ScanStats {
  fps: number;
  successRate: number; // percentage of frames that decoded successfully
  decodedFrames: number;
  totalFrames: number;
}

export interface PreRenderedFrame {
  rPacket: FountainPacket;
  gPacket: FountainPacket;
  bPacket: FountainPacket;
  imageData: ImageData;
  sendSeq: number;
}

