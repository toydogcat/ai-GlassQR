/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { FountainPacket } from './types';

// Deterministic seedable PRNG
export class SimplePrng {
  private state: number;

  constructor(seed: number) {
    // Ensure state is uint32 and is non-zero
    this.state = (seed ? seed : 1) >>> 0;
  }

  next(): number {
    // Classic LCG parameters
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min)) + min;
  }
}

// Fast 16-bit FNV-1a checksum
export function fnv1a16(data: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = (hash * 0x01000193) >>> 0;
  }
  return (hash ^ (hash >> 16)) & 0xffff;
}

// Convert Uint8Array to Base64 string safely and quickly
export function uint8ArrayToBase64(arr: Uint8Array): string {
  let binary = '';
  const len = arr.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

// Convert Base64 string to Uint8Array safely
export function base64ToUint8Array(b64: string): Uint8Array {
  const binaryString = atob(b64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Select degree d using stable Soliton-style distribution
export function selectDegree(prng: SimplePrng, totalBlocks: number): number {
  if (totalBlocks <= 2) return Math.min(2, totalBlocks);
  
  const r = prng.next();
  // Simplified Soliton parameters optimized for sub-seconds Belief Propagation
  if (r < 0.15) return 1;          // 15% chance to have a single block (systematic-like help)
  if (r < 0.50) return 2;          // 35% chance to mix 2 blocks
  if (r < 0.75) return 3;          // 25% chance to mix 3 blocks
  if (r < 0.90) return 5;          // 15% chance to mix 5 blocks
  if (r < 0.97) return 10;         // 7% chance to mix 10 blocks
  return Math.min(30, totalBlocks); // 3% chance for high mixing
}

// Select 'degree' numbers of unique indices from 0 to totalBlocks - 1
export function selectIndices(prng: SimplePrng, degree: number, totalBlocks: number): number[] {
  const indices: number[] = [];
  while (indices.length < degree) {
    const idx = prng.nextInt(0, totalBlocks);
    if (!indices.includes(idx)) {
      indices.push(idx);
    }
  }
  return indices.sort((a, b) => a - b);
}

// Select QR version mapping based on Base64 payload byte capacities under standard 'M' level error corrections
export interface QrConfig {
  version: number;
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H';
}

export function getQrConfigForBlockSize(blockSize: number): QrConfig {
  const totalBytes = 20 + blockSize;

  // Exact maximum byte capacities for Level M (versions 1 to 40)
  const capacitiesM = [
    0, // 0 index
    14, 26, 42, 62, 84, 106, 122, 152, 180, 213, // 1-10
    251, 287, 331, 362, 412, 450, 504, 560, 624, 664, // 11-20
    732, 772, 824, 872, 924, 980, 1040, 1104, 1172, 1244, // 21-30
    1320, 1400, 1484, 1572, 1664, 1760, 1860, 1964, 2072, 2184 // 31-40
  ];

  for (let version = 1; version <= 40; version++) {
    if (totalBytes <= capacitiesM[version]) {
      return { version, errorCorrectionLevel: 'M' };
    }
  }

  // If it exceeds Level M version 40, fallback to Level L
  // Version 40 Level L capacity is 2953 bytes
  if (totalBytes <= 2953) {
    return { version: 40, errorCorrectionLevel: 'L' };
  }

  return { version: 40, errorCorrectionLevel: 'L' };
}

export function getQrVersionForBlockSize(blockSize: number): number {
  return getQrConfigForBlockSize(blockSize).version;
}

/**
 * Protocol Service: Handles slicing files, creating systematic fountain packets, 
 * serializing/deserializing QR strings, and performing Belief Propagation decoding.
 */
export class ProtocolService {
  /**
   * Slice original file into blocks padding the last one.
   */
  static sliceFile(fileBytes: Uint8Array, blockSize: number): Uint8Array[] {
    const totalBlocks = Math.ceil(fileBytes.length / blockSize);
    const blocks: Uint8Array[] = [];

    for (let i = 0; i < totalBlocks; i++) {
      const start = i * blockSize;
      const end = start + blockSize;
      const block = new Uint8Array(blockSize);
      
      const chunk = fileBytes.subarray(start, Math.min(end, fileBytes.length));
      block.set(chunk, 0);
      blocks.push(block);
    }

    return blocks;
  }

  /**
   * Generate a packet for a given seq index
   */
  static generatePacket(
    fileId: number,
    seq: number,
    blocks: Uint8Array[],
    originalSize: number,
    blockSize: number
  ): FountainPacket {
    const totalBlocks = blocks.length;
    let payload = new Uint8Array(blockSize);

    if (seq < totalBlocks) {
      // Systematic packet: directly copy source block
      payload.set(blocks[seq]);
    } else {
      // XOR fountain packet: combine multiple random blocks
      const prng = new SimplePrng(seq);
      const degree = selectDegree(prng, totalBlocks);
      const indices = selectIndices(prng, degree, totalBlocks);

      // Perform bitwise XOR combinations
      for (const idx of indices) {
        const sourceBlock = blocks[idx];
        for (let j = 0; j < blockSize; j++) {
          payload[j] ^= sourceBlock[j];
        }
      }
    }

    const check = fnv1a16(payload);

    return {
      fileId,
      seq,
      totalBlocks,
      originalSize,
      blockSize,
      checksum: check,
      payload,
    };
  }

  /**
   * Serialize FountainPacket into a compact Uint8Array for QR code
   */
  static serializePacket(packet: FountainPacket): Uint8Array {
    const headerSize = 20;
    const buffer = new Uint8Array(headerSize + packet.payload.length);

    // Magic standard GQR
    buffer[0] = 71; // 'G'
    buffer[1] = 81; // 'Q'
    buffer[2] = 82; // 'R'

    // File ID
    buffer[3] = packet.fileId & 0xff;

    // Seq (4 bytes)
    const view = new DataView(buffer.buffer);
    view.setUint32(4, packet.seq, true);        // true = little endian
    view.setUint32(8, packet.totalBlocks, true);
    view.setUint32(12, packet.originalSize, true);
    view.setUint16(16, packet.blockSize, true);
    view.setUint16(18, packet.checksum, true);

    // Payload
    buffer.set(packet.payload, headerSize);

    return buffer;
  }

  /**
   * Deserializes a string or Uint8Array/Uint8ClampedArray back into a FountainPacket.
   * Returns null if signature is invalid or checksum mismatches.
   */
  static deserializePacket(encoded: string | Uint8Array | Uint8ClampedArray): FountainPacket | null {
    try {
      let buffer: Uint8Array;
      if (typeof encoded === 'string') {
        buffer = base64ToUint8Array(encoded);
      } else if (encoded instanceof Uint8Array) {
        buffer = encoded;
      } else {
        buffer = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
      }

      if (buffer.length < 20) return null;

      // Match magic signature 'GQR'
      if (buffer[0] !== 71 || buffer[1] !== 81 || buffer[2] !== 82) {
        return null;
      }

      const fileId = buffer[3];
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const seq = view.getUint32(4, true);
      const totalBlocks = view.getUint32(8, true);
      const originalSize = view.getUint32(12, true);
      const blockSize = view.getUint16(16, true);
      const checksum = view.getUint16(18, true);

      const payload = buffer.subarray(20);
      if (payload.length !== blockSize) {
        return null;
      }

      // Verify payload's integrity
      if (fnv1a16(payload) !== checksum) {
        return null;
      }

      return {
        fileId,
        seq,
        totalBlocks,
        originalSize,
        blockSize,
        checksum,
        payload: new Uint8Array(payload),
      };
    } catch {
      return null;
    }
  }
}

/**
 * Belief Propagation Solver: Receives random dynamic packet combinations 
 * and solves the linear XOR equations system incrementally.
 */
export class FountainSolver {
  public fileId: number = -1;
  public totalBlocks: number = 0;
  public blockSize: number = 0;
  public originalSize: number = 0;

  // Solved blocks (index -> bytes or null)
  public solvedBlocks: (Uint8Array | null)[] = [];
  public solvedCount: number = 0;

  // Active equations system
  private equations: { indices: number[]; payload: Uint8Array }[] = [];

  constructor(metadata: { fileId: number; totalBlocks: number; blockSize: number; originalSize: number }) {
    this.fileId = metadata.fileId;
    this.totalBlocks = metadata.totalBlocks;
    this.blockSize = metadata.blockSize;
    this.originalSize = metadata.originalSize;

    this.solvedBlocks = Array(this.totalBlocks).fill(null);
    this.solvedCount = 0;
    this.equations = [];
  }

  /**
   * Inject a parsed FountainPacket. Returns true if it helped reveal new blocks.
   */
  addPacket(packet: FountainPacket): boolean {
    if (packet.fileId !== this.fileId) return false;
    if (this.isSolved()) return false;

    // Reconstruct packet visual dependencies
    let indices: number[] = [];
    if (packet.seq < this.totalBlocks) {
      indices = [packet.seq];
    } else {
      const prng = new SimplePrng(packet.seq);
      const d = selectDegree(prng, this.totalBlocks);
      indices = selectIndices(prng, d, this.totalBlocks);
    }

    // Allocate copy of payload to perform linear reductions
    const payload = new Uint8Array(packet.payload);

    return this.solveEquation(indices, payload);
  }

  /**
   * Solves an equation indices XOR = payload using dynamic back-substitution.
   */
  private solveEquation(indices: number[], payload: Uint8Array): boolean {
    // 1. Simplify equation using all blocks resolved so far
    let simplifiedIndices = indices.filter((idx) => {
      const solved = this.solvedBlocks[idx];
      if (solved) {
        // XOR the solved block out of the equation's RHS
        for (let j = 0; j < this.blockSize; j++) {
          payload[j] ^= solved[j];
        }
        return false; // remove from unsolved index list
      }
      return true;
    });

    if (simplifiedIndices.length === 0) {
      return false; // fully redundant equation, skip
    }

    // 2. If equation reduced to degree 1, we solved a new source block!
    if (simplifiedIndices.length === 1) {
      const solvedIndex = simplifiedIndices[0];
      if (this.solvedBlocks[solvedIndex] === null) {
        this.solvedBlocks[solvedIndex] = payload;
        this.solvedCount++;

        // Propagate recursively into all currently stored active equations
        this.propagateSolvedBlock(solvedIndex, payload);
        return true;
      }
      return false;
    }

    // 3. Check for duplicates in equations
    const key = simplifiedIndices.join(',');
    for (const eq of this.equations) {
      if (eq.indices.join(',') === key) {
        return false; // exact redundant equation
      }
    }

    // 4. Save equation to try resolving later when more blocks are simplified
    this.equations.push({ indices: simplifiedIndices, payload });
    return false;
  }

  /**
   * Propagate a newly solved block into all stored equations, 
   * resolving cascade degree-1 decodings.
   */
  private propagateSolvedBlock(solvedIdx: number, solvedPayload: Uint8Array) {
    const newlySolved: { index: number; payload: Uint8Array }[] = [];

    // Filter and update variables
    this.equations = this.equations.filter((eq) => {
      const containsIdx = eq.indices.indexOf(solvedIdx);
      if (containsIdx !== -1) {
        // XOR the solved block from the equation payload
        for (let j = 0; j < this.blockSize; j++) {
          eq.payload[j] ^= solvedPayload[j];
        }
        // Remove variable
        eq.indices.splice(containsIdx, 1);

        // Check if degree reduces to 1
        if (eq.indices.length === 1) {
          const resolveIdx = eq.indices[0];
          if (this.solvedBlocks[resolveIdx] === null) {
            this.solvedBlocks[resolveIdx] = eq.payload;
            this.solvedCount++;
            newlySolved.push({ index: resolveIdx, payload: eq.payload });
          }
          return false; // remove solved equation
        } else if (eq.indices.length === 0) {
          return false; // redundant empty equation, remove
        }
      }
      return true;
    });

    // Recursively cascade-propagate any solved variables
    for (const item of newlySolved) {
      this.propagateSolvedBlock(item.index, item.payload);
    }
  }

  isSolved(): boolean {
    return this.solvedCount === this.totalBlocks;
  }

  getProgressFraction(): number {
    if (this.totalBlocks === 0) return 0;
    return this.solvedCount / this.totalBlocks;
  }

  /**
   * Reassembles solved blocks into final byte array, truncating mathematical padding.
   */
  assembleFile(): Uint8Array {
    const combinedBytes = new Uint8Array(this.totalBlocks * this.blockSize);
    for (let i = 0; i < this.totalBlocks; i++) {
      const block = this.solvedBlocks[i];
      if (!block) {
        throw new Error(`Cannot reassemble: Block ${i} is still unsolved.`);
      }
      combinedBytes.set(block, i * this.blockSize);
    }

    // Truncate trailing zero bytes added during block padding
    return combinedBytes.slice(0, this.originalSize);
  }
}
