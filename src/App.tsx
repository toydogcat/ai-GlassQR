/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  Upload,
  Play,
  Pause,
  RefreshCw,
  Camera,
  Layers,
  FileDown,
  Activity,
  CheckCircle2,
  FileText,
  Sliders,
  Sparkles,
  Zap,
  RotateCcw,
  Eye,
  Video,
  Music,
  Image as ImageIcon,
  FileCode,
  Copy,
  Check,
} from 'lucide-react';

import { FileMetadata, FountainPacket, PreRenderedFrame } from './types';
import {
  ProtocolService,
  FountainSolver,
  getQrConfigForBlockSize,
  base64ToUint8Array,
} from './protocol';
import { buildAnimatedWebP, demuxAnimatedWebP } from './webp';

export default function App() {
  // --- Core Application States ---
  const [activeTab, setActiveTab] = useState<'send' | 'receive'>('send');

  // --- Transmitter (Send) States ---
  const [sendFile, setSendFile] = useState<File | null>(null);
  const [sendMetadata, setSendMetadata] = useState<FileMetadata | null>(null);
  const [sendBlocks, setSendBlocks] = useState<Uint8Array[]>([]);
  const [sendSeq, setSendSeq] = useState<number>(0);
  const [isTransmitting, setIsTransmitting] = useState<boolean>(false);
  const [transmitFps, setTransmitFps] = useState<number>(25);
  const [selectedBlockSize, setSelectedBlockSize] = useState<number>(256);
  const [preRenderingPercent, setPreRenderingPercent] = useState<number>(-1);

  // Buffer lists for exporting Animated WebPs
  const [recordedFrames, setRecordedFrames] = useState<Uint8Array[]>([]);
  const [isRecordingWebP, setIsRecordingWebP] = useState<boolean>(false);

  // --- Receiver (Scan) States ---
  const [solver, setSolver] = useState<FountainSolver | null>(null);
  const [receiveMetadata, setReceiveMetadata] = useState<FileMetadata | null>(null);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [cameraActive, setCameraActive] = useState<boolean>(false);
  const [isDemuxing, setIsDemuxing] = useState<boolean>(false);

  // Performance / Stats tracking
  const [scannedCount, setScannedCount] = useState<number>(0);
  const [duplicateCount, setDuplicateCount] = useState<number>(0);
  const [decodeFps, setDecodeFps] = useState<number>(0);
  const [receiveHistory, setReceiveHistory] = useState<boolean[]>([]); // tracked solved block slots

  // Camera devices
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');

  // Finished restored file
  const [restoredBlob, setRestoredBlob] = useState<Blob | null>(null);
  const [restoredUrl, setRestoredUrl] = useState<string>('');
  const [previewTextContent, setPreviewTextContent] = useState<string>('');
  const [previewCopied, setPreviewCopied] = useState<boolean>(false);

  // --- Loopback System Simulation States ---
  const [loopbackActive, setLoopbackActive] = useState<boolean>(false);
  const [loopbackPacketLoss, setLoopbackPacketLoss] = useState<number>(20); // 20% simulated packet loss

  // --- Refs ---
  const transmitCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const receiveCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const preRenderedFramesRef = useRef<PreRenderedFrame[]>([]);
  const nextFrameSeqRef = useRef<number>(0);
  const isGeneratingRef = useRef<boolean>(false);
  const playRefIndex = useRef<number>(0);
  const workerRef = useRef<Worker | null>(null);
  const isWorkerBusyRef = useRef<boolean>(false);

  // Interval IDs
  const transmitIntervalRef = useRef<any>(null);
  const statsIntervalRef = useRef<any>(null);
  const frameCountRef = useRef<number>(0);

  // Track systematic vs XOR stream indexes for RGB channel merging
  const channelSeqRef = useRef<{ r: number; g: number; b: number }>({ r: 0, g: 1, b: 2 });

  // -------------------------------------------------------------
  // 1. Initialise & Enumerate Devices
  // -------------------------------------------------------------
  useEffect(() => {
    async function getDevices() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        // Close temporary stream immediately
        stream.getTracks().forEach((track) => track.stop());

        const deviceInfos = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = deviceInfos.filter((d) => d.kind === 'videoinput');
        setDevices(videoDevices);
        if (videoDevices.length > 0) {
          // Try to find a back/rear camera to default to
          const backCam = videoDevices.find((d) =>
            d.label.toLowerCase().includes('back') ||
            d.label.toLowerCase().includes('rear') ||
            d.label.toLowerCase().includes('environment') ||
            d.label.includes('後') ||
            d.label.includes('主鏡頭')
          );
          setSelectedDeviceId(backCam ? backCam.deviceId : videoDevices[0].deviceId);
        }
      } catch (err) {
        console.warn('Could not list video devices:', err);
      }
    }
    getDevices();
  }, []);

  // Iframe scroll message broadcasting for dynamic navigation adjustment
  useEffect(() => {
    let lastScrollY = 0;
    const scrollThreshold = 8;
    
    const handleScroll = () => {
      const currentScrollY = window.scrollY || document.documentElement.scrollTop;
      if (Math.abs(currentScrollY - lastScrollY) < scrollThreshold && currentScrollY > 10) return;
      
      const direction = currentScrollY > lastScrollY ? 'down' : 'up';
      
      window.parent.postMessage({
        type: 'iframe_scroll',
        scrollY: currentScrollY,
        direction: direction
      }, '*');
      
      lastScrollY = currentScrollY;
    };
    
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Vercount update trigger on tab / SPA view change
  useEffect(() => {
    // @ts-ignore
    if (window.vercount && typeof window.vercount.fetch === 'function') {
      // @ts-ignore
      window.vercount.fetch();
    }
  }, [activeTab]);

  // Helper to categorize restored file types for rich media rendering
  const getFileType = (name: string, type: string) => {
    const normName = name.toLowerCase();
    const normType = type.toLowerCase();
    if (normType.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(normName)) {
      return 'image';
    }
    if (normType.startsWith('video/') || /\.(mp4|webm|ogg|mov|mkv|3gp)$/.test(normName)) {
      return 'video';
    }
    if (normType.startsWith('audio/') || /\.(mp3|wav|ogg|aac|flac|m4a)$/.test(normName)) {
      return 'audio';
    }
    if (
      normType.startsWith('text/') ||
      normType.includes('json') ||
      normType.includes('xml') ||
      normType.includes('javascript') ||
      /\.(txt|md|json|csv|xml|js|ts|tsx|html|css|ini|log|yaml|yml)$/.test(normName)
    ) {
      return 'text';
    }
    if (normType.includes('pdf') || /\.pdf$/.test(normName)) {
      return 'pdf';
    }
    return 'unknown';
  };

  // Automatically read preview text content if it's text
  useEffect(() => {
    if (!restoredBlob || !receiveMetadata) {
      setPreviewTextContent('');
      return;
    }
    const fileType = getFileType(receiveMetadata.name, restoredBlob.type || receiveMetadata.type || '');
    if (fileType === 'text') {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        if (text) {
          if (text.length > 50000) {
            setPreviewTextContent(text.slice(0, 50000) + '\n\n...[下略，內容過長已被截斷預覽]...');
          } else {
            setPreviewTextContent(text);
          }
        }
      };
      reader.onerror = () => {
        setPreviewTextContent('讀取文字檔案失敗');
      };
      reader.readAsText(restoredBlob);
    } else {
      setPreviewTextContent('');
    }
  }, [restoredBlob, receiveMetadata]);

  // -------------------------------------------------------------
  // Pre-rendering & Web Worker Decoding Utilities (Milestone 4 Bottom-layer Enhancements)
  // -------------------------------------------------------------

  // Pre-render a sliding window queue (e.g. initial 60 frames) upfront to keep UI silky smooth on selection start,
  // then dynamically refill in the background during transmission.
  const preRenderTransmitterFrames = async (meta: FileMetadata, blocks: Uint8Array[]) => {
    setPreRenderingPercent(0);
    const cache: PreRenderedFrame[] = [];
    const maxFrames = 60; // Initial pre-render buffer size of 60 frames (2.4 seconds at 25 FPS)

    nextFrameSeqRef.current = 0;

    const qrConfig = getQrConfigForBlockSize(meta.blockSize);
    const qrVersion = qrConfig.version;
    const ecc = qrConfig.errorCorrectionLevel;
    
    // Auto-adjust cellSize so that each cell/module has a larger physical pixel area!
    const dummyPacket = ProtocolService.generatePacket(meta.id, 0, blocks, meta.size, meta.blockSize);
    const dummyStr = ProtocolService.serializePacket(dummyPacket);
    let n = 157; // Default fallback module dimension for version 35
    try {
      const dummyQr = QRCode.create(dummyStr, { version: qrVersion, errorCorrectionLevel: ecc });
      n = dummyQr.modules.size;
    } catch (e) {
      console.warn("Failed to derive module size:", e);
    }
    
    // Calculate cell size dynamically so that the cells have a large area (cellSize * cellSize >= 64 pixels)
    const cellSize = n < 50 ? 14 : n < 100 ? 10 : 8; 
    const margin = 32; // visually generous quiet zone frame
    const sizePx = n * cellSize + margin * 2;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = sizePx;
    tempCanvas.height = sizePx;
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) return;

    // Process in batches of 15 frames to prevent blocking the UI thread during pre-generation
    const batchSize = 15;
    for (let i = 0; i < maxFrames; i += batchSize) {
      const end = Math.min(i + batchSize, maxFrames);
      for (let frameIndex = i; frameIndex < end; frameIndex++) {
        const rSeq = frameIndex * 3;
        const gSeq = frameIndex * 3 + 1;
        const bSeq = frameIndex * 3 + 2;

        const rPacket = ProtocolService.generatePacket(meta.id, rSeq, blocks, meta.size, meta.blockSize);
        const gPacket = ProtocolService.generatePacket(meta.id, gSeq, blocks, meta.size, meta.blockSize);
        const bPacket = ProtocolService.generatePacket(meta.id, bSeq, blocks, meta.size, meta.blockSize);

        const rStr = ProtocolService.serializePacket(rPacket);
        const gStr = ProtocolService.serializePacket(gPacket);
        const bStr = ProtocolService.serializePacket(bPacket);

        try {
          const rQr = QRCode.create(rStr, { version: qrVersion, errorCorrectionLevel: ecc });
          const gQr = QRCode.create(gStr, { version: qrVersion, errorCorrectionLevel: ecc });
          const bQr = QRCode.create(bStr, { version: qrVersion, errorCorrectionLevel: ecc });

          // Reset white quiet zone background
          tempCtx.fillStyle = '#ffffff';
          tempCtx.fillRect(0, 0, sizePx, sizePx);

          for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
              const rBit = rQr.modules.get(x, y);
              const gBit = gQr.modules.get(x, y);
              const bBit = bQr.modules.get(x, y);

              const rVal = rBit ? 0 : 255;
              const gVal = gBit ? 0 : 255;
              const bVal = bBit ? 0 : 255;

              tempCtx.fillStyle = `rgb(${rVal}, ${gVal}, ${bVal})`;
              tempCtx.fillRect(margin + x * cellSize, margin + y * cellSize, cellSize, cellSize);
            }
          }

          const imageData = tempCtx.getImageData(0, 0, sizePx, sizePx);
          cache.push({
            rPacket,
            gPacket,
            bPacket,
            imageData,
            sendSeq: bSeq + 1,
          });
        } catch (err) {
          console.error("Failed to pre-render dynamic matrix frame:", err);
        }
      }

      setPreRenderingPercent(Math.round((end / maxFrames) * 100));
      // Give React main loop browser paint cycles
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    preRenderedFramesRef.current = cache;
    nextFrameSeqRef.current = maxFrames;
    playRefIndex.current = 0; // Reset play pointer
    setPreRenderingPercent(-1);
  };

  // Dynamically refill pre-rendered cache in background during transmission
  const refillPreRenderQueue = async (meta: FileMetadata, blocks: Uint8Array[]) => {
    if (isGeneratingRef.current) return;
    isGeneratingRef.current = true;

    try {
      const cache = preRenderedFramesRef.current;
      const targetSize = 60; // Keep a sliding buffer of 60 frames

      if (cache.length >= targetSize) {
        isGeneratingRef.current = false;
        return;
      }

      const batchSize = 15;
      const toGenerate = Math.min(batchSize, targetSize - cache.length);

      const qrConfig = getQrConfigForBlockSize(meta.blockSize);
      const qrVersion = qrConfig.version;
      const ecc = qrConfig.errorCorrectionLevel;

      const dummyPacket = ProtocolService.generatePacket(meta.id, 0, blocks, meta.size, meta.blockSize);
      const dummyStr = ProtocolService.serializePacket(dummyPacket);
      let n = 157;
      try {
        const dummyQr = QRCode.create(dummyStr, { version: qrVersion, errorCorrectionLevel: ecc });
        n = dummyQr.modules.size;
      } catch (e) {
        console.warn("Failed to derive module size in background:", e);
      }

      const cellSize = n < 50 ? 14 : n < 100 ? 10 : 8;
      const margin = 32;
      const sizePx = n * cellSize + margin * 2;

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = sizePx;
      tempCanvas.height = sizePx;
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) {
        isGeneratingRef.current = false;
        return;
      }

      for (let i = 0; i < toGenerate; i++) {
        const frameIndex = nextFrameSeqRef.current;
        nextFrameSeqRef.current += 1;

        const rSeq = frameIndex * 3;
        const gSeq = frameIndex * 3 + 1;
        const bSeq = frameIndex * 3 + 2;

        const rPacket = ProtocolService.generatePacket(meta.id, rSeq, blocks, meta.size, meta.blockSize);
        const gPacket = ProtocolService.generatePacket(meta.id, gSeq, blocks, meta.size, meta.blockSize);
        const bPacket = ProtocolService.generatePacket(meta.id, bSeq, blocks, meta.size, meta.blockSize);

        const rStr = ProtocolService.serializePacket(rPacket);
        const gStr = ProtocolService.serializePacket(gPacket);
        const bStr = ProtocolService.serializePacket(bPacket);

        try {
          const rQr = QRCode.create(rStr, { version: qrVersion, errorCorrectionLevel: ecc });
          const gQr = QRCode.create(gStr, { version: qrVersion, errorCorrectionLevel: ecc });
          const bQr = QRCode.create(bStr, { version: qrVersion, errorCorrectionLevel: ecc });

          tempCtx.fillStyle = '#ffffff';
          tempCtx.fillRect(0, 0, sizePx, sizePx);

          for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
              const rBit = rQr.modules.get(x, y);
              const gBit = gQr.modules.get(x, y);
              const bBit = bQr.modules.get(x, y);

              const rVal = rBit ? 0 : 255;
              const gVal = gBit ? 0 : 255;
              const bVal = bBit ? 0 : 255;

              tempCtx.fillStyle = `rgb(${rVal}, ${gVal}, ${bVal})`;
              tempCtx.fillRect(margin + x * cellSize, margin + y * cellSize, cellSize, cellSize);
            }
          }

          const imageData = tempCtx.getImageData(0, 0, sizePx, sizePx);
          cache.push({
            rPacket,
            gPacket,
            bPacket,
            imageData,
            sendSeq: bSeq + 1,
          });
        } catch (err) {
          console.error("Failed to pre-render dynamic matrix frame inside queue:", err);
        }
      }

      preRenderedFramesRef.current = cache;
    } catch (e) {
      console.error("Error in refillPreRenderQueue:", e);
    } finally {
      isGeneratingRef.current = false;
    }
  };

  // Web Worker Initializer with async transferables
  const initWebWorker = () => {
    if (workerRef.current) return;

    // Fast inline Web Worker code string
    const workerCode = `
      self.importScripts('https://unpkg.com/jsqr@1.4.0/dist/jsQR.js');

      self.onmessage = function(e) {
        try {
          const { imgDataBuffer, w, h } = e.data;
          const imgData = new Uint8ClampedArray(imgDataBuffer);
          
          const rData = new Uint8ClampedArray(w * h * 4);
          const gData = new Uint8ClampedArray(w * h * 4);
          const bData = new Uint8ClampedArray(w * h * 4);

          for (let i = 0; i < w * h; i++) {
            const idx = i * 4;
            const r = imgData[idx];
            const g = imgData[idx + 1];
            const b = imgData[idx + 2];
            const a = imgData[idx + 3];

            // Cross-talk compensation (subtract overlapping leakage from other channels)
            let rClean = r - 0.4 * Math.max(0, g - r) - 0.4 * Math.max(0, b - r);
            if (rClean < 0) rClean = 0; else if (rClean > 255) rClean = 255;

            let gClean = g - 0.4 * Math.max(0, r - g) - 0.4 * Math.max(0, b - g);
            if (gClean < 0) gClean = 0; else if (gClean > 255) gClean = 255;

            let bClean = b - 0.4 * Math.max(0, r - b) - 0.4 * Math.max(0, g - b);
            if (bClean < 0) bClean = 0; else if (bClean > 255) bClean = 255;

            // Red Channel Monochromatic map
            rData[idx] = rClean; rData[idx+1] = rClean; rData[idx+2] = rClean; rData[idx+3] = a;
            // Green Channel Monochromatic map
            gData[idx] = gClean; gData[idx+1] = gClean; gData[idx+2] = gClean; gData[idx+3] = a;
            // Blue Channel Monochromatic map
            bData[idx] = bClean; bData[idx+1] = bClean; bData[idx+2] = bClean; bData[idx+3] = a;
          }

          const rScan = jsQR(rData, w, h);
          const gScan = jsQR(gData, w, h);
          const bScan = jsQR(bData, w, h);

          self.postMessage({
            rPayload: rScan ? rScan.data : null,
            gPayload: gScan ? gScan.data : null,
            bPayload: bScan ? bScan.data : null
          });
        } catch (err) {
          self.postMessage({ error: err.message });
        }
      };
    `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);

    worker.onmessage = (e: MessageEvent) => {
      isWorkerBusyRef.current = false;
      if (e.data.error) {
        console.error("Web Worker error:", e.data.error);
        return;
      }
      const { rPayload, gPayload, bPayload } = e.data;
      handleDecodedPayloads(rPayload, gPayload, bPayload);
    };

    workerRef.current = worker;
  };

  const handleDecodedPayloads = (
    rPayload: string | null,
    gPayload: string | null,
    bPayload: string | null
  ) => {
    const scannedPackets: FountainPacket[] = [];
    if (rPayload) {
      const p = ProtocolService.deserializePacket(rPayload);
      if (p) scannedPackets.push(p);
    }
    if (gPayload) {
      const p = ProtocolService.deserializePacket(gPayload);
      if (p) scannedPackets.push(p);
    }
    if (bPayload) {
      const p = ProtocolService.deserializePacket(bPayload);
      if (p) scannedPackets.push(p);
    }

    // Accumulate decoded packets indicator count
    frameCountRef.current += 3;

    if (scannedPackets.length > 0) {
      let currentSolver = solver;
      if (!currentSolver || currentSolver.fileId !== scannedPackets[0].fileId) {
        const meta: FileMetadata = {
          id: scannedPackets[0].fileId,
          name: `Restoring_File_${scannedPackets[0].fileId}`,
          size: scannedPackets[0].originalSize,
          type: 'application/octet-stream',
          totalBlocks: scannedPackets[0].totalBlocks,
          blockSize: scannedPackets[0].blockSize,
        };
        restartReceiverWithMetadata(meta);
        currentSolver = new FountainSolver({
          fileId: meta.id,
          totalBlocks: meta.totalBlocks,
          blockSize: meta.blockSize,
          originalSize: meta.size,
        });
      }

      let solvedAny = false;
      for (const packet of scannedPackets) {
        const wasAdded = currentSolver.addPacket(packet);
        if (wasAdded) {
          solvedAny = true;
        } else {
          setDuplicateCount((d) => d + 1);
        }
      }

      if (solvedAny) {
        setSolver(currentSolver);
        setScannedCount(currentSolver.solvedCount);
        setReceiveHistory([...currentSolver.solvedBlocks.map((b) => b !== null)]);

        if (currentSolver.isSolved()) {
          setIsScanning(false);
          stopCamera();
          handleDecodeSuccess(currentSolver);
        }
      }
    }
  };

  // -------------------------------------------------------------
  // 2. Transmitter (Send) Logic
  // -------------------------------------------------------------
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    loadSendFile(file);
  };

  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    loadSendFile(file);
  };

  const loadSendFile = async (file: File, blockSizeOverride?: number) => {
    setSendFile(file);
    const arrayBuffer = await file.arrayBuffer();
    const fileBytes = new Uint8Array(arrayBuffer);

    const size = fileBytes.length;
    const activeBlockSize = blockSizeOverride !== undefined ? blockSizeOverride : selectedBlockSize;
    const blocksList = ProtocolService.sliceFile(fileBytes, activeBlockSize);

    const meta: FileMetadata = {
      id: Math.floor(Math.random() * 250) + 5, // random File ID (0-255 range byte)
      name: file.name,
      size: size,
      type: file.type || 'application/octet-stream',
      totalBlocks: blocksList.length,
      blockSize: activeBlockSize,
    };

    setSendMetadata(meta);
    setSendBlocks(blocksList);
    setSendSeq(0);
    setRecordedFrames([]);
    setIsTransmitting(false);

    // If loopback simulation was active, auto-restart it with the new file
    if (loopbackActive) {
      restartReceiverWithMetadata(meta);
    }

    // Run custom pre-rendering queue asynchronously
    await preRenderTransmitterFrames(meta, blocksList);
  };

  const changeBlockSize = (size: number) => {
    setSelectedBlockSize(size);
    if (sendFile) {
      // Re-slice and reset file with new block size
      loadSendFile(sendFile, size);
    }
  };

  // -------------------------------------------------------------
  // 3. Render Custom RGB-Multiplexed QR Codes on Canvas
  // -------------------------------------------------------------
  const renderRgbFrameAndGetPackets = async (): Promise<{
    rPacket: FountainPacket;
    gPacket: FountainPacket;
    bPacket: FountainPacket;
    frameData: Uint8Array | null;
  } | null> => {
    if (!sendMetadata || sendBlocks.length === 0) return null;

    // We increment seq pointers for Red, Green, and Blue channels
    const rSeq = channelSeqRef.current.r;
    const gSeq = channelSeqRef.current.g;
    const bSeq = channelSeqRef.current.b;

    // Create 3 independent Fountain Packets
    const rPacket = ProtocolService.generatePacket(
      sendMetadata.id,
      rSeq,
      sendBlocks,
      sendMetadata.size,
      sendMetadata.blockSize
    );
    const gPacket = ProtocolService.generatePacket(
      sendMetadata.id,
      gSeq,
      sendBlocks,
      sendMetadata.size,
      sendMetadata.blockSize
    );
    const bPacket = ProtocolService.generatePacket(
      sendMetadata.id,
      bSeq,
      sendBlocks,
      sendMetadata.size,
      sendMetadata.blockSize
    );

    // Serialize to Base64
    const rStr = ProtocolService.serializePacket(rPacket);
    const gStr = ProtocolService.serializePacket(gPacket);
    const bStr = ProtocolService.serializePacket(bPacket);

    // Generate standard base QR matrices
    const qrConfig = getQrConfigForBlockSize(sendMetadata.blockSize);
    const qrVersion = qrConfig.version;
    const ecc = qrConfig.errorCorrectionLevel;

    try {
      // Using QRCode.create to extract matrices
      const rQr = QRCode.create(rStr, { version: qrVersion, errorCorrectionLevel: ecc });
      const gQr = QRCode.create(gStr, { version: qrVersion, errorCorrectionLevel: ecc });
      const bQr = QRCode.create(bStr, { version: qrVersion, errorCorrectionLevel: ecc });

      const n = rQr.modules.size;
      const cellSize = 6; // Standard size per module
      const margin = 24; // Visual border margin
      const sizePx = n * cellSize + margin * 2;

      const canvas = transmitCanvasRef.current;
      if (!canvas) return null;

      if (canvas.width !== sizePx) {
        canvas.width = sizePx;
        canvas.height = sizePx;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      // Draw background space
      ctx.fillStyle = '#ffffff'; // standard compliant white quiet zone
      ctx.fillRect(0, 0, sizePx, sizePx);

      // Loop matrices and merge channels
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const rBit = rQr.modules.get(x, y);
          const gBit = gQr.modules.get(x, y);
          const bBit = bQr.modules.get(x, y);

          let rVal = rBit ? 0 : 255;
          let gVal = gBit ? 0 : 255;
          let bVal = bBit ? 0 : 255;

          ctx.fillStyle = `rgb(${rVal}, ${gVal}, ${bVal})`;
          ctx.fillRect(
            margin + x * cellSize,
            margin + y * cellSize,
            cellSize,
            cellSize
          );
        }
      }

      // Progressively update channel index pointers
      channelSeqRef.current.r = rSeq + 3;
      channelSeqRef.current.g = gSeq + 3;
      channelSeqRef.current.b = bSeq + 3;
      setSendSeq((prev) => prev + 3);

      // Extract raw frame buffer if exporting WebP matches active recorder
      let webpBytes: Uint8Array | null = null;
      if (isRecordingWebP) {
        const frameDataUrl = canvas.toDataURL('image/webp', 1.0);
        if (frameDataUrl.startsWith('data:image/webp;base64,')) {
          webpBytes = base64ToUint8Array(frameDataUrl.split(',')[1]);
        }
      }

      return {
        rPacket,
        gPacket,
        bPacket,
        frameData: webpBytes,
      };
    } catch (err) {
      console.error('Error generating RGB QR Frame matrix:', err);
      return null;
    }
  };

  // Transmit loop controller
  useEffect(() => {
    if (isTransmitting && sendMetadata) {
      const intervalMs = Math.round(1000 / transmitFps);
      
      const tick = async () => {
        // Refill sliding window queue if it runs low
        if (preRenderedFramesRef.current.length < 30) {
          refillPreRenderQueue(sendMetadata, sendBlocks);
        }

        const cache = preRenderedFramesRef.current;
        if (cache && cache.length > 0) {
          const frame = cache.shift()!;

          const canvas = transmitCanvasRef.current;
          if (canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx) {
              if (canvas.width !== frame.imageData.width) {
                canvas.width = frame.imageData.width;
                canvas.height = frame.imageData.height;
              }
              ctx.putImageData(frame.imageData, 0, 0);

              // Extract WebP bytes for animation compilation when recording is active
              if (isRecordingWebP) {
                const frameDataUrl = canvas.toDataURL('image/webp', 1.0);
                if (frameDataUrl.startsWith('data:image/webp;base64,')) {
                  const webpBytes = base64ToUint8Array(frameDataUrl.split(',')[1]);
                  setRecordedFrames((prev) => [...prev, webpBytes]);
                }
              }
            }
          }

          setSendSeq(frame.sendSeq);

          // Handle simultaneous local Loopback Simulation transfers!
          if (loopbackActive && solver) {
            const simulatePacket = (packet: FountainPacket) => {
              if (Math.random() * 100 >= loopbackPacketLoss) {
                solver.addPacket(packet);
              }
            };
            simulatePacket(frame.rPacket);
            simulatePacket(frame.gPacket);
            simulatePacket(frame.bPacket);

            // Force stats screen refresh
            setScannedCount(solver.solvedCount);
            setReceiveHistory([...solver.solvedBlocks.map((b) => b !== null)]);

            if (solver.isSolved()) {
              setIsTransmitting(false);
              setLoopbackActive(false);
              handleDecodeSuccess(solver);
            }
          }
        } else {
          // Fallback to real-time calculation if cache is somehow empty
          const result = await renderRgbFrameAndGetPackets();
          if (result && isRecordingWebP && result.frameData) {
            setRecordedFrames((prev) => [...prev, result.frameData!]);
          }

          // Handle simultaneous local Loopback Simulation transfers!
          if (loopbackActive && result && solver) {
            const simulatePacket = (packet: FountainPacket) => {
              if (Math.random() * 100 >= loopbackPacketLoss) {
                solver.addPacket(packet);
              }
            };
            simulatePacket(result.rPacket);
            simulatePacket(result.gPacket);
            simulatePacket(result.bPacket);

            // Force stats screen refresh
            setScannedCount(solver.solvedCount);
            setReceiveHistory([...solver.solvedBlocks.map((b) => b !== null)]);

            if (solver.isSolved()) {
              setIsTransmitting(false);
              setLoopbackActive(false);
              handleDecodeSuccess(solver);
            }
          }
        }
      };

      // Run immediately first
      tick();
      transmitIntervalRef.current = setInterval(tick, intervalMs);
    } else {
      if (transmitIntervalRef.current) {
        clearInterval(transmitIntervalRef.current);
      }
    }

    return () => {
      if (transmitIntervalRef.current) {
        clearInterval(transmitIntervalRef.current);
      }
    };
  }, [isTransmitting, sendMetadata, transmitFps, loopbackActive, isRecordingWebP, loopbackPacketLoss, solver]);

  const toggleTransmit = () => {
    setIsTransmitting((prev) => !prev);
  };

  // Reset transmitter
  const resetTransmitter = async () => {
    setIsTransmitting(false);
    setSendSeq(0);
    playRefIndex.current = 0;
    nextFrameSeqRef.current = 0;
    preRenderedFramesRef.current = [];
    channelSeqRef.current = { r: 0, g: 1, b: 2 };
    setRecordedFrames([]);
    // Clear canvas
    const canvas = transmitCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    // Re-trigger pre-rendering of initial frames
    if (sendMetadata && sendBlocks.length > 0) {
      await preRenderTransmitterFrames(sendMetadata, sendBlocks);
    }
  };

  // -------------------------------------------------------------
  // 4. WebP Animation Export Logic (Milestone 3)
  // -------------------------------------------------------------
  const startRecordingWebP = () => {
    setRecordedFrames([]);
    setIsRecordingWebP(true);
    setIsTransmitting(true);
  };

  const stopAndDownloadWebP = () => {
    setIsTransmitting(false);
    setIsRecordingWebP(false);

    if (recordedFrames.length === 0 || !sendMetadata) {
      alert('尚未錄製任何動畫訊框，請先傳送檔案封包！');
      return;
    }

    // Capture dimensions of actual canvas
    const canvas = transmitCanvasRef.current;
    if (!canvas) return;

    try {
      const frameDelay = Math.round(1000 / transmitFps);
      const webpBlob = buildAnimatedWebP(
        recordedFrames,
        canvas.width,
        canvas.height,
        frameDelay
      );

      const url = URL.createObjectURL(webpBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${sendMetadata.name.split('.')[0]}_dynamic_optical.webp`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to construct animated WebP stream:', err);
      alert('打包訊框時發生錯誤: ' + err);
    }
  };

  // -------------------------------------------------------------
  // 5. Receiver (Scan) Logic
  // -------------------------------------------------------------
  const restartReceiverWithMetadata = (meta: FileMetadata) => {
    // Instantiate brand new solver representing this dynamic file transfer
    const newSolver = new FountainSolver({
      fileId: meta.id,
      totalBlocks: meta.totalBlocks,
      blockSize: meta.blockSize,
      originalSize: meta.size,
    });

    setSolver(newSolver);
    setReceiveMetadata(meta);
    setScannedCount(0);
    setDuplicateCount(0);
    setReceiveHistory(Array(meta.totalBlocks).fill(false));
    setRestoredBlob(null);
    if (restoredUrl) {
      URL.revokeObjectURL(restoredUrl);
      setRestoredUrl('');
    }
  };

  // Core scan loop: process camera frame extraction & decode via offscreen Web Worker
  const processFrameDecode = () => {
    const video = videoRef.current;
    const canvas = receiveCanvasRef.current;
    if (!video || !canvas || !cameraActive || !isScanning) return;

    // Canvas size holds standard capture resolution
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth || 480;
      canvas.height = video.videoHeight || 480;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Draw frame onto processing canvas so the camera preview looks extremely smooth on-screen
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Only delegate to the worker if it isn't currently busy decoding previous frames
    if (workerRef.current && !isWorkerBusyRef.current) {
      isWorkerBusyRef.current = true;
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const w = canvas.width;
      const h = canvas.height;

      // Use transferables (zero-copy buffer routing) to maximize performance
      workerRef.current.postMessage({
        imgDataBuffer: imgData.data.buffer,
        w,
        h,
      }, [imgData.data.buffer]);
    }

    if (isScanning && cameraActive) {
      requestAnimationFrame(processFrameDecode);
    }
  };

  // Start Camera WebRTC
  const startCamera = async () => {
    try {
      setCameraActive(true);
      setIsScanning(true);
      
      // Initialize the Web Worker!
      initWebWorker();

      const constraints: MediaStreamConstraints = {
        video: selectedDeviceId
          ? {
              deviceId: { exact: selectedDeviceId },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : {
              facingMode: 'environment',
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }

      // Start fps tick counters
      frameCountRef.current = 0;
      statsIntervalRef.current = setInterval(() => {
        setDecodeFps(frameCountRef.current);
        frameCountRef.current = 0;
      }, 1000);

      // Trigger standard frame processors
      setTimeout(() => {
        requestAnimationFrame(processFrameDecode);
      }, 500);
    } catch (err) {
      alert('無法啟動網路相機: ' + err);
      setCameraActive(false);
      setIsScanning(false);
    }
  };

  const stopCamera = () => {
    setIsScanning(false);
    setCameraActive(false);
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }

    // Terminate Web Worker to release system memory
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    isWorkerBusyRef.current = false;

    setDecodeFps(0);
  };

  const handleDecodeSuccess = (activeSolver: FountainSolver) => {
    try {
      const fileBytes = activeSolver.assembleFile();
      // Format to proper output mime mapping if possible
      const blob = new Blob([fileBytes], { type: receiveMetadata?.type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      setRestoredBlob(blob);
      setRestoredUrl(url);

      // Flash success audio or micro-interaction
      try {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, audioCtx.currentTime);
        osc.frequency.setValueAtTime(1200, audioCtx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
      } catch {}
    } catch (err) {
      console.error('File assembly failure:', err);
      alert('組合檔案失敗: ' + err);
    }
  };

  // -------------------------------------------------------------
  // 6. Demux Dragged-and-Dropped WebP Animations (Milestone 3 Offline)
  // -------------------------------------------------------------
  const handleWebpDropOrUpload = async (e: React.ChangeEvent<HTMLInputElement> | React.DragEvent<HTMLDivElement>) => {
    let file: File | null = null;
    if ('dataTransfer' in e) {
      e.preventDefault();
      file = e.dataTransfer.files?.[0] || null;
    } else {
      file = e.target.files?.[0] || null;
    }

    if (!file) return;

    setIsDemuxing(true);
    setScannedCount(0);
    setDuplicateCount(0);
    setReceiveHistory([]);

    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // Parse the animated WebP into separate frames
      const frames = demuxAnimatedWebP(bytes);
      if (frames.length === 0) {
        throw new Error('No valid nested dynamic matrices (ANMF chunks) found within this WebP file.');
      }

      // Create an offscreen solver that we build-up as frames are decrypted using a ref-like object to bypass typescript narrowing.
      const activeSolverRef = { current: null as FountainSolver | null };

      // Extract details sequentially loading images onto temporary canvases
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const img = new Image();

        await new Promise<void>((resolve) => {
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || 400;
            canvas.height = img.naturalHeight || 400;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(img, 0, 0);
              const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              
              const w = canvas.width;
              const h = canvas.height;

              // Channel split
              const rData = new Uint8ClampedArray(w * h * 4);
              const gData = new Uint8ClampedArray(w * h * 4);
              const bData = new Uint8ClampedArray(w * h * 4);

              for (let j = 0; j < w * h; j++) {
                const idx = j * 4;
                const r = imgData.data[idx];
                const g = imgData.data[idx + 1];
                const b = imgData.data[idx + 2];
                const a = imgData.data[idx + 3];

                // Cross-talk compensation (subtract overlapping leakage from other channels)
                let rClean = r - 0.4 * Math.max(0, g - r) - 0.4 * Math.max(0, b - r);
                if (rClean < 0) rClean = 0; else if (rClean > 255) rClean = 255;

                let gClean = g - 0.4 * Math.max(0, r - g) - 0.4 * Math.max(0, b - g);
                if (gClean < 0) gClean = 0; else if (gClean > 255) gClean = 255;

                let bClean = b - 0.4 * Math.max(0, r - b) - 0.4 * Math.max(0, g - b);
                if (bClean < 0) bClean = 0; else if (bClean > 255) bClean = 255;

                rData[idx] = rClean; rData[idx+1] = rClean; rData[idx+2] = rClean; rData[idx+3] = a;
                gData[idx] = gClean; gData[idx+1] = gClean; gData[idx+2] = gClean; gData[idx+3] = a;
                bData[idx] = bClean; bData[idx+1] = bClean; bData[idx+2] = bClean; bData[idx+3] = a;
              }

              // Scan
              const rScan = jsQR(rData, w, h);
              const gScan = jsQR(gData, w, h);
              const bScan = jsQR(bData, w, h);

              const parsedPackets: FountainPacket[] = [];
              if (rScan?.data) {
                const p = ProtocolService.deserializePacket(rScan.data);
                if (p) parsedPackets.push(p);
              }
              if (gScan?.data) {
                const p = ProtocolService.deserializePacket(gScan.data);
                if (p) parsedPackets.push(p);
              }
              if (bScan?.data) {
                const p = ProtocolService.deserializePacket(bScan.data);
                if (p) parsedPackets.push(p);
              }

              if (parsedPackets.length > 0) {
                if (!activeSolverRef.current) {
                  const sample = parsedPackets[0];
                  const meta: FileMetadata = {
                    id: sample.fileId,
                    name: file?.name ? file.name.replace('_dynamic_optical.webp', '.bin') : `Decrypted_Output_${sample.fileId}`,
                    size: sample.originalSize,
                    type: 'application/octet-stream',
                    totalBlocks: sample.totalBlocks,
                    blockSize: sample.blockSize,
                  };
                  
                  // Initialize Solver setup
                  setReceiveMetadata(meta);
                  activeSolverRef.current = new FountainSolver({
                     fileId: meta.id,
                     totalBlocks: meta.totalBlocks,
                     blockSize: meta.blockSize,
                     originalSize: meta.size,
                  });
                  setReceiveHistory(Array(meta.totalBlocks).fill(false));
                }

                for (const packet of parsedPackets) {
                  activeSolverRef.current.addPacket(packet);
                }

                // Push visual feedback
                setSolver(activeSolverRef.current);
                setScannedCount(activeSolverRef.current.solvedCount);
                setReceiveHistory([...activeSolverRef.current.solvedBlocks.map((b) => b !== null)]);
              }
            }
            URL.revokeObjectURL(frame.dataUrl);
            resolve();
          };
          img.onerror = () => {
            URL.revokeObjectURL(frame.dataUrl);
            resolve();
          };
          img.src = frame.dataUrl;
        });

        if (activeSolverRef.current && activeSolverRef.current.isSolved()) {
          break; // instantly reconstruct early if full system rank attained!
        }
      }

      setIsDemuxing(false);

      if (activeSolverRef.current && activeSolverRef.current.isSolved()) {
        handleDecodeSuccess(activeSolverRef.current);
      } else {
        alert('WebP 處理完成，但檔案無法完全重組（不重複的封包數量不足）。');
      }

    } catch (err: any) {
      console.error(err);
      setIsDemuxing(false);
      alert('解析 WebP 動態檔案時發生錯誤: ' + err.message);
    }
  };

  // -------------------------------------------------------------
  // 7. Loopback Active Self-Test Simulation Logic (Adrenaline booster!)
  // -------------------------------------------------------------
  const toggleLoopback = () => {
    if (!sendMetadata) {
      alert('請先在傳送面板上載入/拖入檔案，再執行本機回環自測。');
      return;
    }

    if (!loopbackActive) {
      // Set receiver to match send specs
      restartReceiverWithMetadata(sendMetadata);
      setLoopbackActive(true);
      setIsTransmitting(true);
      // Switch screen so they see the magical cascade solver in action
      setActiveTab('receive');
    } else {
      setLoopbackActive(false);
      setIsTransmitting(false);
    }
  };

  const getPercentageString = (count: number, total: number) => {
    if (total === 0) return '0%';
    return `${Math.round((count / total) * 100)}%`;
  };

  // Clean layout helper for lists
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-teal-500 selection:text-slate-950" id="glass-app">
      {/* Dynamic Header */}
      <header className="border-b border-slate-900 bg-slate-950/80 backdrop-blur-md sticky top-0 z-50 py-4 px-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4" id="header-root">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-tr from-teal-500 to-indigo-600 p-2.5 rounded-xl shadow-lg ring-1 ring-white/10 flex items-center justify-center animate-pulse" id="logo-icon">
            <Zap className="w-6 h-6 text-slate-950 stroke-[2.5]" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-teal-400 via-emerald-300 to-indigo-400 bg-clip-text text-transparent" id="app-title">
              GlassQR 光學傳輸系統
            </h1>
            <p className="text-xs text-slate-400 font-medium">
              免後端、高速噴泉編碼 RGB 多路複用光學鏈路
            </p>
          </div>
        </div>

        {/* Global Tab Toggles & Setup Info */}
        <div className="flex items-center gap-2 bg-slate-900 p-1 rounded-xl ring-1 ring-white/5" id="tab-nav">
          <button
            onClick={() => setActiveTab('send')}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 ${
              activeTab === 'send'
                ? 'bg-gradient-to-r from-teal-500 to-indigo-500 text-slate-950 shadow-md transform scale-[1.02]'
                : 'text-slate-400 hover:text-slate-200'
            }`}
            id="tab-send-btn"
          >
            <Layers className="w-3.5 h-3.5" />
            發送端 (傳送)
          </button>
          <button
            onClick={() => setActiveTab('receive')}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 ${
              activeTab === 'receive'
                ? 'bg-gradient-to-r from-teal-500 to-indigo-500 text-slate-950 shadow-md transform scale-[1.02]'
                : 'text-slate-400 hover:text-slate-200'
            }`}
            id="tab-recv-btn"
          >
            <Camera className="w-3.5 h-3.5" />
            接收端 (掃描)
          </button>
        </div>
      </header>

      {/* Main Grid Viewport */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8" id="main-grid">
        
        {/* ========================================================= */}
        {/* LEFT COLUMN: SOURCE DATA & TRANS_FLOW VIEWPORT */}
        {/* ========================================================= */}
        <section className={`lg:col-span-5 space-y-6 ${activeTab === 'send' ? 'block' : 'hidden lg:block'}`} id="send-column">
          {/* File input / Drag & Drop Card */}
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 relative overflow-hidden backdrop-blur-sm shadow-xl" id="uploader-card">
            <div className="absolute top-0 right-0 w-24 h-24 bg-teal-500/5 blur-2xl rounded-full" />
            <h2 className="text-sm font-semibold tracking-wide uppercase text-slate-300 flex items-center gap-2 mb-4">
              <Upload className="w-4 h-4 text-teal-400" />
              1. 載入來源檔案 ({formatBytes(sendFile?.size || 0)})
            </h2>

            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleFileDrop}
              className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-300 ${
                sendFile
                  ? 'border-teal-500/40 bg-teal-950/10'
                  : 'border-slate-800 hover:border-slate-700 hover:bg-slate-800/20'
              }`}
              id="dropzone"
            >
              <input
                type="file"
                onChange={handleFileSelect}
                className="hidden"
                id="file-input-field"
              />
              <label htmlFor="file-input-field" className="cursor-pointer flex flex-col items-center w-full">
                <div className="p-3 bg-slate-800/80 rounded-xl mb-3 text-teal-400 group-hover:scale-110 transition-transform">
                  <Upload className="w-6 h-6" />
                </div>
                {sendFile ? (
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-teal-300 line-clamp-1">{sendFile.name}</p>
                    <p className="text-xs text-slate-400">拖曳以覆蓋檔案</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-slate-200">將檔案拖曳至此，或點擊瀏覽檔案</p>
                    <p className="text-xs text-slate-500">支援 2MB 內的文件、壓縮檔、照片</p>
                  </div>
                )}
              </label>
            </div>

            {/* Transmitter Configurations */}
            {sendMetadata && (
              <div className="mt-4 p-4 bg-slate-950/60 rounded-xl border border-slate-800/60 space-y-3" id="meta-container">
                <div className="grid grid-cols-2 gap-3 text-[11px]">
                  <div>
                    <span className="text-slate-500 block">檔案 ID</span>
                    <span className="font-mono text-indigo-300 font-bold">{sendMetadata.id}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">總區塊數</span>
                    <span className="font-mono text-emerald-400 font-bold">{sendMetadata.totalBlocks} 個區塊</span>
                  </div>
                </div>

                <div className="border-t border-slate-900 pt-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400 flex items-center gap-1">
                      <Sliders className="w-3.5 h-3.5 text-slate-400" />
                      區塊大小
                    </span>
                    <div className="flex gap-1 bg-slate-900 p-0.5 rounded-lg border border-slate-800">
                      {[128, 256, 512, 1024, 1536].map((size) => (
                        <button
                          key={size}
                          onClick={() => changeBlockSize(size)}
                          className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase transition-all ${
                            selectedBlockSize === size
                              ? 'bg-teal-500/20 text-teal-300 ring-1 ring-teal-500/30'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {size >= 1024 ? `${size / 1024}KB` : `${size}B`}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-slate-400">
                      <span className="flex items-center gap-1">
                        <Activity className="w-3.5 h-3.5" />
                        傳輸速度: <b className="text-teal-400 font-bold">{transmitFps} FPS</b>
                      </span>
                      <span>(~{Math.round(((transmitFps * selectedBlockSize * 3) / 1024) * 10) / 10} KB/s)</span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="30"
                      value={transmitFps}
                      onChange={(e) => setTransmitFps(parseInt(e.target.value))}
                      className="w-full accent-teal-500 h-1 bg-slate-800 rounded-lg"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Transmitter Dynamic Matrix Display Screen */}
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 relative overflow-hidden backdrop-blur-sm shadow-xl flex flex-col items-center" id="framer-card">
            <h2 className="text-sm font-semibold tracking-wide uppercase text-slate-300 flex items-center gap-2 mb-4 self-start w-full justify-between">
              <span className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-teal-400" />
                2. 即時光學快閃播放
              </span>
              {sendMetadata && (
                <span className="font-mono text-[10px] text-slate-500 uppercase">
                  序列: {sendSeq}
                </span>
              )}
            </h2>

            {sendFile ? (
              <div className="space-y-6 flex flex-col items-center w-full">
                {/* QR Screen container with custom fluorescent glow */}
                <div className="relative group p-4 bg-slate-950 border border-slate-800 rounded-2xl shadow-inner flex items-center justify-center min-h-[300px] w-full" id="flicker-screen-box">
                  <div className="absolute -inset-1 bg-gradient-to-tr from-teal-500 to-indigo-500 rounded-2xl opacity-10 blur-xl group-hover:opacity-15 transition" />
                  <canvas
                    ref={transmitCanvasRef}
                    className="max-w-[280px] w-full h-auto bg-slate-900 rounded-lg aspect-square border border-slate-800"
                    id="transmit-optical-canvas"
                  />
                  {!isTransmitting && (
                    <div className="absolute inset-0 bg-slate-950/80 flex flex-col items-center justify-center p-6 text-center backdrop-blur-sm rounded-xl">
                      {preRenderingPercent >= 0 ? (
                        <>
                          <div className="p-3 bg-slate-900 border border-slate-800 rounded-full mb-3 text-teal-400 animate-spin">
                            <RefreshCw className="w-6 h-6" />
                          </div>
                          <p className="text-sm font-bold text-slate-200">預渲染矩陣影格中 ({preRenderingPercent}%)</p>
                          <p className="text-xs text-slate-400 mt-1 max-w-[200px]">正在為高速傳輸生成前置緩衝...</p>
                        </>
                      ) : (
                        <>
                          <div className="p-3 bg-slate-900 border border-slate-800 rounded-full mb-3 text-teal-400">
                            <Play className="w-6 h-6 translate-x-0.5 pointer-events-none" />
                          </div>
                          <p className="text-sm font-bold text-slate-200">光學串流處於閒置狀態</p>
                          <p className="text-xs text-slate-400 mt-1 max-w-[200px]">點擊「開始」以播放動態矩陣畫面。</p>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Stream Controls */}
                <div className="flex flex-col gap-3 w-full">
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={toggleTransmit}
                      className={`flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 ${
                        isTransmitting
                          ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 ring-2 ring-amber-500/20'
                          : 'bg-gradient-to-r from-teal-500 to-emerald-500 hover:brightness-110 text-slate-950'
                      }`}
                      id="action-transmit-toggle"
                    >
                      {isTransmitting ? (
                        <>
                          <Pause className="w-4 h-4 fill-slate-950" /> 暫停鏈路
                        </>
                      ) : (
                        <>
                          <Play className="w-4 h-4 fill-slate-950" /> 開始鏈路
                        </>
                      )}
                    </button>

                    <button
                      onClick={resetTransmitter}
                      className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700/60 active:scale-95"
                      id="action-transmit-reset"
                    >
                      <RotateCcw className="w-4 h-4" /> 重設串流
                    </button>
                  </div>

                  {/* WebP Animations packager (Milestone 3 tool) */}
                  <div className="pt-2 border-t border-slate-900 flex flex-col gap-2">
                    <div className="flex justify-between items-center text-[11px] text-slate-500">
                      <span>動畫擷取器 (WEBP 打包)</span>
                      {recordedFrames.length > 0 && (
                        <span className="text-teal-400 font-bold">已排隊 {recordedFrames.length} 個影格</span>
                      )}
                    </div>
                    {isRecordingWebP ? (
                      <button
                        onClick={stopAndDownloadWebP}
                        className="flex items-center justify-center gap-2 py-2 px-3 rounded-xl text-[11px] font-bold bg-indigo-500 hover:bg-indigo-400 text-slate-950 shadow-md ring-2 ring-indigo-500/20 animate-pulse w-full"
                        id="action-webp-download"
                      >
                        <FileDown className="w-3.5 h-3.5" /> 停止並打包動態 WebP 鏈路
                      </button>
                    ) : (
                      <button
                        onClick={startRecordingWebP}
                        className="flex items-center justify-center gap-2 py-2 px-3 rounded-xl text-[11px] font-bold bg-slate-800 hover:bg-slate-750 text-slate-200 border border-indigo-500/30 w-full"
                        id="action-webp-record"
                      >
                        <Layers className="w-3.5 h-3.5 text-indigo-400" /> 擷取畫面並打包為動態 WebP
                      </button>
                    )}
                  </div>

                  {/* High adrenaline Loopback simulator! */}
                  <div className="pt-2 border-t border-slate-900 flex flex-col gap-2 bg-slate-950/20 p-3 rounded-xl">
                    <div className="flex justify-between items-center text-[11px]">
                      <span className="text-teal-500 font-bold flex items-center gap-1">
                        <Eye className="w-3 h-3" />
                        本機回環自測
                      </span>
                      <span className="text-slate-400">模擬實體相機傳輸</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-1.5">
                      <button
                        onClick={toggleLoopback}
                        className={`flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg text-[10px] font-bold transition-all ${
                          loopbackActive
                            ? 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40'
                            : 'bg-teal-500/10 text-teal-400 hover:bg-teal-500/25 border border-teal-500/30'
                        }`}
                        id="loopback-sim-btn"
                      >
                        {loopbackActive ? '取消模擬' : '啟動本機測試'}
                      </button>
                      <div className="space-y-1">
                        <div className="flex justify-between text-[9px] text-slate-500 font-mono">
                          <span>封包遺失率</span>
                          <span>{loopbackPacketLoss}%</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="90"
                          step="10"
                          value={loopbackPacketLoss}
                          onChange={(e) => setLoopbackPacketLoss(parseInt(e.target.value))}
                          className="w-full h-1 bg-slate-800 accent-teal-500"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-12 text-center text-slate-500 flex flex-col items-center justify-center max-w-xs space-y-3" id="fallback-framer">
                <Layers className="w-10 h-10 text-slate-700 stroke-[1.5]" />
                <p className="text-sm text-slate-400">未載入任何檔案</p>
                <p className="text-xs text-slate-500">
                  請在上方選擇一個檔案，我們將會把它打包成彩色多路複用的動態訊框序列。
                </p>
              </div>
            )}
          </div>
        </section>

        {/* ========================================================= */}
        {/* RIGHT COLUMN: RECEIVER DECRYPTOR VIEWPORT */}
        {/* ========================================================= */}
        <section className={`lg:col-span-7 space-y-6 ${activeTab === 'receive' ? 'block' : 'hidden lg:block'}`} id="recv-column">
          
          {/* Main Receiver Active Terminal Panel */}
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 relative overflow-hidden backdrop-blur-sm shadow-xl" id="scan-terminal">
            <h2 className="text-sm font-semibold tracking-wide uppercase text-slate-300 flex items-center justify-between mb-4" id="recv-header">
              <span className="flex items-center gap-2">
                <Camera className="w-4 h-4 text-teal-400 animate-pulse" />
                擷取串流與解碼器
              </span>
              {decodeFps > 0 && (
                <span className="bg-emerald-950/60 text-emerald-400 font-mono text-[10px] px-2 py-0.5 rounded border border-emerald-900 font-bold flex items-center gap-1 animate-pulse">
                  ● 作用中 (訊道頻率: {decodeFps} Hz)
                </span>
              )}
            </h2>

            {/* Input toggle picker */}
            <div className="grid grid-cols-2 gap-4 bg-slate-950 p-1.5 rounded-xl border border-slate-800 mb-6" id="input-stream-picker">
              <button
                onClick={() => {
                  stopCamera();
                  setCameraActive(false);
                }}
                className={`flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-all ${
                  !cameraActive
                    ? 'bg-slate-800 text-slate-100 font-bold ring-1 ring-slate-700'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
                id="input-file-opt"
              >
                <Layers className="w-3.5 h-3.5" />
                上傳離線 WebP
              </button>
              <button
                onClick={() => {
                  if (!cameraActive) {
                    startCamera();
                  }
                }}
                className={`flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-all ${
                  cameraActive
                    ? 'bg-teal-500/10 text-teal-300 font-bold ring-1 ring-teal-500/40'
                    : 'text-slate-500 hover:text-slate-100'
                }`}
                id="input-camera-opt"
              >
                <Camera className="w-3.5 h-3.5" />
                WebRTC 相機掃描
              </button>
            </div>

            {/* Interactive Stream Box */}
            <div className="relative rounded-2xl overflow-hidden bg-slate-950 border border-slate-800 min-h-[320px] flex flex-col items-center justify-center" id="scanning-viewport">
              {/* WebRTC Camera Scanning viewport interface */}
              {cameraActive ? (
                <div className="w-full h-full relative" id="webrtc-box">
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    autoPlay
                    className="w-full h-auto aspect-video object-cover bg-slate-900 rounded-lg max-h-[360px]"
                    id="scanner-video-feed"
                  />
                  {/* Subtle Canvas used to extract frames */}
                  <canvas ref={receiveCanvasRef} className="hidden" />

                  {/* Target Guide square reticle (Milestone 4 Alignment Assist) */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none" id="reticle-overlay">
                    <div className="w-[180px] h-[180px] md:w-[240px] md:h-[240px] border-2 border-dashed border-teal-400 rounded-3xl relative animate-pulse shadow-[0_0_15px_rgba(20,184,166,0.15)] flex items-center justify-center">
                      <div className="absolute top-2 left-2 w-4 h-4 border-t-2 border-l-2 border-teal-300" />
                      <div className="absolute top-2 right-2 w-4 h-4 border-t-2 border-r-2 border-teal-305" />
                      <div className="absolute bottom-2 left-2 w-4 h-4 border-b-2 border-l-2 border-teal-305" />
                      <div className="absolute bottom-2 right-2 w-4 h-4 border-b-2 border-r-2 border-teal-305" />
                      
                      {/* Guide description text */}
                      <span className="text-[9px] text-teal-400 bg-slate-950/80 px-2.5 py-1 rounded-full uppercase border border-teal-500/20 backdrop-blur tracking-widest leading-none">
                        請對準彩色 QR 碼
                      </span>
                    </div>
                  </div>

                  {/* Device selectors overlay control */}
                  <div className="absolute bottom-3 left-3 right-3 bg-slate-950/90 border border-slate-800 rounded-xl p-2 flex items-center justify-between gap-3 backdrop-blur" id="device-controls">
                    <div className="flex items-center gap-1 text-[10px] text-slate-400 uppercase font-mono font-bold pl-1">
                      <Sliders className="w-3 h-3 text-slate-500" /> 鏡頭選擇器
                    </div>
                    {devices.length > 1 ? (
                      <select
                        value={selectedDeviceId}
                        onChange={(e) => {
                          setSelectedDeviceId(e.target.value);
                          stopCamera();
                          // Restart with selected camera UUID
                          setTimeout(() => startCamera(), 300);
                        }}
                        className="bg-slate-900 text-slate-200 text-xs px-2.5 py-1 rounded border border-slate-700 outline-none w-48 font-semibold"
                        id="camera-select"
                      >
                        {devices.map((device, idx) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `相機 ${idx + 1}`}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-[10px] text-slate-500 uppercase font-mono">
                        系統相機使用中
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                /* Offline WebP animation load / Drop Interface (Milestone 3 Tool) */
                <div className="w-full flex flex-col items-center justify-center p-8 text-center space-y-4" id="offline-webp-drop">
                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleWebpDropOrUpload}
                    className="border-2 border-dashed border-slate-800 rounded-xl p-8 hover:border-slate-700 w-full hover:bg-slate-900/40 cursor-pointer flex flex-col items-center justify-center text-center transition-all min-h-[220px]"
                    id="webp-dropzone"
                  >
                    <input
                      type="file"
                      accept=".webp"
                      onChange={handleWebpDropOrUpload}
                      className="hidden"
                      id="webp-file-input"
                    />
                    <label htmlFor="webp-file-input" className="cursor-pointer flex flex-col items-center w-full">
                      <div className="p-3 bg-slate-900 border border-slate-850 rounded-2xl mb-4 text-indigo-400 hover:scale-105 transition-transform">
                        <FileText className="w-8 h-8" />
                      </div>
                      <p className="text-sm font-semibold text-slate-200">
                        拖曳高速動態 WebP 檔案至此
                      </p>
                      <p className="text-xs text-slate-500 max-w-xs mt-1">
                        我們將會把其拆回原本的獨立色彩訊框，並 100% 離線還原檔案。
                      </p>
                    </label>
                  </div>
                </div>
              )}

              {/* Busy demux loaders (Milestone 3) */}
              {isDemuxing && (
                <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center space-y-3 z-30" id="demux-popup">
                  <RefreshCw className="w-8 h-8 text-indigo-400 animate-spin" />
                  <p className="text-xs text-indigo-300 font-mono tracking-widest uppercase">
                    正在拆解 WebP 訊框...
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Belief Propagation Solver Cascade visualizer diagnostics (Milestone 4 Rank check) */}
          {receiveMetadata && (
            <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 relative overflow-hidden backdrop-blur-sm shadow-xl space-y-6" id="decoder-dashboard">
              
              {/* Overall Progress state */}
              <div className="space-y-3" id="overall-status">
                <div className="flex justify-between items-end">
                  <div className="space-y-0.5">
                    <span className="text-[10px] text-slate-500 font-mono uppercase">解密進度</span>
                    <h3 className="text-sm font-bold text-slate-300 line-clamp-1">
                      {receiveMetadata.name}
                    </h3>
                  </div>
                  <div className="text-right">
                    <span className="text-2xl font-black font-mono tracking-tight bg-gradient-to-r from-teal-400 to-indigo-400 bg-clip-text text-transparent">
                      {getPercentageString(scannedCount, receiveMetadata.totalBlocks)}
                    </span>
                    <span className="text-[10px] text-slate-500 block font-mono">
                      已還原 {scannedCount} 之 {receiveMetadata.totalBlocks} 個來源區塊
                    </span>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="w-full bg-slate-950 rounded-full h-2.5 overflow-hidden border border-slate-900 flex">
                  <div
                    className="h-full bg-gradient-to-r from-teal-500 via-emerald-400 to-indigo-500 shadow-[0_0_12px_rgba(20,184,166,0.3)] transition-all duration-300 rounded-full"
                    style={{ width: `${(scannedCount / receiveMetadata.totalBlocks) * 100}%` }}
                  />
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 bg-slate-950 p-2.5 rounded-xl text-[10px] border border-slate-900 font-mono text-slate-400 uppercase">
                  <div>
                    <span className="text-[9px] text-slate-600 block">檔案 ID</span>
                    <span className="text-indigo-400 font-bold">{receiveMetadata.id}</span>
                  </div>
                  <div>
                    <span className="text-[9px] text-slate-600 block">區塊大小</span>
                    <span className="text-slate-300 font-bold">{receiveMetadata.blockSize} 位元組</span>
                  </div>
                  <div>
                    <span className="text-[9px] text-slate-600 block">忽略重複封包</span>
                    <span className="text-slate-300 font-bold">{duplicateCount}</span>
                  </div>
                  <div>
                    <span className="text-[9px] text-slate-600 block">已解碼傳輸量</span>
                    <span className="text-emerald-400 font-bold">~{scannedCount ? formatBytes(scannedCount * receiveMetadata.blockSize) : '0 Bytes'}</span>
                  </div>
                </div>
              </div>

              {/* Belief Propagation Linear System grid representation (High Adrenaline Visualizer) */}
              <div className="space-y-2" id="block-grid-area">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-slate-500 font-mono uppercase tracking-wider flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-indigo-400" />
                    信念傳播方程式矩陣求解器
                  </span>
                  <div className="flex gap-4 text-[9px] font-mono font-bold uppercase">
                    <span className="flex items-center gap-1 text-slate-600">
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-800" /> 缺失
                    </span>
                    <span className="flex items-center gap-1 text-teal-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse" /> 解出
                    </span>
                  </div>
                </div>

                {/* Grid matrix representation */}
                <div className="bg-slate-950 p-3 rounded-xl border border-slate-900/60 shadow-inner flex flex-wrap gap-1 max-h-[120px] overflow-y-auto" id="pixel-slots-grid">
                  {receiveHistory.map((isSolved, index) => (
                    <div
                      key={index}
                      className={`w-3 h-3 rounded-[3px] transition-all duration-300 relative group cursor-help ${
                        isSolved
                          ? 'bg-gradient-to-tr from-teal-500 to-emerald-400 shadow-[0_0_4px_rgba(20,184,166,0.4)]'
                          : 'bg-slate-800/80 hover:bg-slate-700/60'
                      }`}
                      title={`${isSolved ? '已解出' : '缺失'} (區塊 #${index})`}
                    >
                      {/* Minor popup coordinate values */}
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 bg-slate-900 text-slate-100 text-[8px] px-1 py-0.5 rounded font-mono hidden group-hover:block whitespace-nowrap z-50">
                        B#{index}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Restored Finished Output file action button wrapper */}
              {restoredBlob && (
                <div className="space-y-4">
                  <div className="p-4 bg-teal-950/20 border border-teal-500/30 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-4 animate-bounce" id="solved-celebration-card">
                    <div className="flex items-center gap-3">
                      <div className="p-2.5 bg-gradient-to-tr from-teal-400 to-emerald-300 rounded-lg text-slate-950 shadow-md flex items-center justify-center animate-pulse">
                        <CheckCircle2 className="w-5 h-5 fill-none stroke-[2.5]" />
                      </div>
                      <div>
                        <h4 className="text-xs font-bold text-teal-300 uppercase tracking-wider font-mono">
                          檔案還原成功！
                        </h4>
                        <p className="text-xs text-slate-300 font-semibold line-clamp-1">
                          成功解碼完整負載: {receiveMetadata.name} ({formatBytes(receiveMetadata.size)})
                        </p>
                      </div>
                    </div>
                    <a
                      href={restoredUrl}
                      download={receiveMetadata.name}
                      className="flex items-center justify-center gap-2 py-2 px-4 rounded-lg text-xs font-bold bg-gradient-to-r from-teal-400 to-emerald-400 hover:brightness-110 text-slate-950 shadow-md transition-all active:scale-95 text-center shrink-0 cursor-pointer"
                      id="action-download-solved"
                    >
                      <FileDown className="w-4 h-4 text-slate-950 stroke-[2] pointer-events-none" />
                      下載檔案
                    </a>
                  </div>

                  {/* Rich File Live Instant Preview Card */}
                  <div className="p-5 bg-slate-950/70 border border-slate-800/80 rounded-xl space-y-4 shadow-xl relative overflow-hidden" id="rich-file-preview-card">
                    <div className="flex items-center justify-between pb-3 border-b border-slate-900/80">
                      <div className="flex items-center gap-2">
                        {(() => {
                          const fType = getFileType(receiveMetadata.name, restoredBlob.type || receiveMetadata.type || '');
                          if (fType === 'image') return <ImageIcon className="w-4 h-4 text-pink-400" />;
                          if (fType === 'video') return <Video className="w-4 h-4 text-amber-400" />;
                          if (fType === 'audio') return <Music className="w-4 h-4 text-cyan-400" />;
                          if (fType === 'text') return <FileCode className="w-4 h-4 text-emerald-400" />;
                          return <FileText className="w-4 h-4 text-indigo-400" />;
                        })()}
                        <span className="text-xs font-bold text-slate-300 font-mono tracking-wider uppercase">
                          檔案解密即時預覽
                        </span>
                      </div>
                      <span className="text-[10px] bg-slate-900 border border-slate-800 text-slate-400 px-2.5 py-0.5 rounded font-mono uppercase">
                        {restoredBlob.type || 'binary payload'}
                      </span>
                    </div>

                    {/* Content area */}
                    {(() => {
                      const fType = getFileType(receiveMetadata.name, restoredBlob.type || receiveMetadata.type || '');

                      if (fType === 'image') {
                        return (
                          <div className="flex flex-col items-center justify-center p-3 bg-slate-900/30 rounded-lg border border-slate-900">
                            <img
                              src={restoredUrl}
                              alt={receiveMetadata.name}
                              referrerPolicy="no-referrer"
                              className="max-h-[320px] object-contain rounded border border-slate-800 shadow-md max-w-full"
                            />
                            <p className="text-[10px] text-slate-500 font-mono mt-2 text-center truncate w-full">
                              檢視: {receiveMetadata.name} ({formatBytes(receiveMetadata.size)})
                            </p>
                          </div>
                        );
                      }

                      if (fType === 'video') {
                        return (
                          <div className="p-3 bg-slate-900/30 rounded-lg border border-slate-900 flex flex-col items-center">
                            <video
                              src={restoredUrl}
                              controls
                              className="w-full max-h-[320px] object-contain rounded border border-slate-800 shadow-lg bg-slate-950"
                              playsInline
                            />
                            <p className="text-[10px] text-slate-500 font-mono mt-2 text-center truncate w-full">
                              影像播放: {receiveMetadata.name} ({formatBytes(receiveMetadata.size)})
                            </p>
                          </div>
                        );
                      }

                      if (fType === 'audio') {
                        return (
                          <div className="p-4 bg-slate-900/30 rounded-lg border border-slate-900 space-y-3">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-full bg-cyan-950/40 flex items-center justify-center text-cyan-400 border border-cyan-500/20">
                                <Music className="w-5 h-5 animate-pulse" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <h5 className="text-xs font-semibold text-slate-300 font-mono truncate" title={receiveMetadata.name}>
                                  {receiveMetadata.name}
                                </h5>
                                <p className="text-[10px] text-slate-500 font-mono">
                                  解碼音軌 // {formatBytes(receiveMetadata.size)}
                                </p>
                              </div>
                            </div>
                            <audio
                              src={restoredUrl}
                              controls
                              className="w-full outline-none mt-1"
                            />
                          </div>
                        );
                      }

                      if (fType === 'text') {
                        return (
                          <div className="space-y-2">
                            <div className="flex justify-between items-center text-[10px] font-mono text-slate-500">
                              <span>文字內容 / 碼流規格 ({previewTextContent.length} 字元)</span>
                              <button
                                type="button"
                                onClick={() => {
                                  if (previewTextContent) {
                                    navigator.clipboard.writeText(previewTextContent);
                                    setPreviewCopied(true);
                                    setTimeout(() => setPreviewCopied(false), 2000);
                                  }
                                }}
                                className="flex items-center gap-1.5 px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 hover:text-emerald-400 border border-slate-800 transition-all cursor-pointer text-[10px]"
                              >
                                {previewCopied ? (
                                  <>
                                    <Check className="w-3 h-3 text-emerald-400" />
                                    <span>已複製</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3 h-3" />
                                    <span>複製內容</span>
                                  </>
                                )}
                              </button>
                            </div>
                            <div className="bg-slate-950 p-4 rounded-lg border border-slate-900/80 overflow-x-auto max-h-[250px] text-xs font-mono text-emerald-300/90 whitespace-pre-wrap shadow-inner scrollbar-thin">
                              {previewTextContent || '載入文字內容中...'}
                            </div>
                          </div>
                        );
                      }

                      if (fType === 'pdf') {
                        return (
                          <div className="p-3 bg-slate-900/30 rounded-lg border border-slate-900 flex flex-col items-center space-y-3">
                            <iframe
                              src={restoredUrl}
                              className="w-full h-[350px] rounded border border-slate-800 bg-white"
                              title="pdf-preview"
                            />
                            <p className="text-[10px] text-slate-500 font-mono">
                              PDF 文件: {receiveMetadata.name} ({formatBytes(receiveMetadata.size)})
                            </p>
                          </div>
                        );
                      }

                      // Unknown binary general format
                      return (
                        <div className="p-4 bg-slate-900/20 rounded-lg border border-slate-850/60 flex items-center gap-3">
                          <div className="p-2.5 bg-slate-950 rounded-lg text-slate-500 border border-slate-900">
                            <FileText className="w-5 h-5 stroke-[1.5]" />
                          </div>
                          <div>
                            <p className="text-xs font-medium text-slate-300">
                              此格式類型不支援瀏覽器直接嵌入式預覽。
                            </p>
                            <p className="text-[10px] text-slate-500 font-mono mt-1">
                              可以正常點擊上方「下載檔案」按鈕。
                            </p>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Offline scan state fallback instructions */}
          {!receiveMetadata && (
            <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-8 relative overflow-hidden backdrop-blur-sm text-center shadow-xl py-14 flex flex-col items-center justify-center space-y-4" id="recv-fallback">
              <Activity className="w-12 h-12 text-slate-800 animate-pulse stroke-[1.2]" />
              <div className="space-y-1">
                <p className="text-sm font-bold text-slate-300">接收端空閒中</p>
                <p className="text-xs text-slate-500 max-w-sm mx-auto">
                  使用相機對準閃爍的彩色動態 QR 碼，或直接拖放擷取的動態 WebP 檔案，即可啟動信念傳播（Belief Propagation）串流重新裝配還原！
                </p>
              </div>
            </div>
          )}
        </section>

      </main>

      {/* Unified footer context info with no-larping details */}
      <footer className="border-t border-slate-900/80 bg-slate-950/60 py-4 px-6 text-center text-[10px] text-slate-500 font-mono flex flex-col items-center justify-center gap-1.5" id="app-footer">
        <div>
          GLASSQR DECENTRALIZED OPTICAL LINK // REED-SOLOMON SYSTEMATIC FOUNTAIN solver v4 // CLIENT-SIDE DEPLOYABLE // ALL CALCULATIONS OFFLINE OVER CANVAS IMAGEDATA
        </div>
        <div className="flex items-center gap-4 text-[10px] text-slate-400">
          <span>全站瀏覽量: <span id="vercount_value_site_pv" className="font-semibold text-emerald-400">--</span> 次</span>
          <span className="text-slate-800">|</span>
          <span>訪客人數: <span id="vercount_value_site_uv" className="font-semibold text-emerald-400">--</span> 人</span>
        </div>
      </footer>
    </div>
  );
}
