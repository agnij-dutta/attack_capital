import { PrismaClient, SessionStatus } from "@prisma/client";
import { transcribeAudio, generateSummary } from "../lib/gemini";
import { writeFile, mkdir, rm, readdir, stat, readFile, mkdtemp, unlink } from "fs/promises";
import { join, resolve, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Server as SocketIOServer } from "socket.io";
import { tmpdir } from "os";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const prisma = new PrismaClient();
const CHUNK_DURATION_MS = 30000; // 30 seconds as per PRD requirement - longer chunks provide better context
const MIN_CHUNK_SIZE_BYTES = 10000; // Minimum chunk size to process (10KB) - larger chunks = better accuracy
const MAX_BUFFER_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

const execAsync = promisify(exec);
const SAVE_MP3_DEBUG =
  process.env.SAVE_MP3_DEBUG !== undefined
    ? process.env.SAVE_MP3_DEBUG === "true"
    : true;
const AUDIO_SESSIONS_ROOT = resolve(__dirname, "sessions");

// Store socket.io instance for real-time updates
let ioInstance: SocketIOServer | null = null;

export function setSocketIOInstance(io: SocketIOServer) {
  ioInstance = io;
}

/**
 * Audio processor for handling streaming audio chunks
 */
export class AudioProcessor {
  private buffers: Map<string, Buffer[]> = new Map();
  private chunkTimers: Map<string, NodeJS.Timeout> = new Map();
  private sessionStartTimes: Map<string, number> = new Map();
  private totalSizes: Map<string, number> = new Map();
  private chunkFileQueues: Map<string, string[]> = new Map();
  private chunkMetadata: Map<
    string,
    { audioLevel?: number; chunkId?: string; size: number }[]
  > = new Map();
  private lastChunkHashes: Map<string, string> = new Map();

  private getSessionDir(sessionId: string): string {
    return join(AUDIO_SESSIONS_ROOT, sessionId);
  }

  /**
   * Initialize a new recording session
   */
  async initializeSession(sessionId: string, userId: string): Promise<void> {
    this.buffers.set(sessionId, []);
    this.sessionStartTimes.set(sessionId, Date.now());
    this.totalSizes.set(sessionId, 0);
    this.chunkFileQueues.set(sessionId, []);
    this.chunkMetadata.set(sessionId, []);
    this.lastChunkHashes.delete(sessionId);

    // Create session in database
    await prisma.recordingSession.create({
      data: {
        id: sessionId,
        userId,
        status: SessionStatus.RECORDING,
        title: `Session ${new Date().toLocaleString()}`,
      },
    });
  }

  /**
   * Add audio chunk to buffer and process if needed
   */
  async addChunk(
    sessionId: string,
    audioData: Buffer,
    mimeType: string = "audio/webm",
    metadata?: { audioLevel?: number; chunkId?: string }
  ): Promise<void> {
    // Validate chunk size - skip very small chunks that are likely empty/silent
    if (audioData.length < 1024) {
      console.warn(`[AudioProcessor] Skipping very small chunk for ${sessionId}: ${audioData.length} bytes (likely empty/silent)`);
      return;
    }

    const currentSize = this.totalSizes.get(sessionId) || 0;
    const newSize = currentSize + audioData.length;

    // Check buffer overflow
    if (newSize > MAX_BUFFER_SIZE) {
      throw new Error("Buffer overflow: Session exceeds maximum size");
    }

    console.log(`[AudioProcessor] Adding chunk for ${sessionId}: ${audioData.length} bytes, total: ${newSize} bytes`);

    const bufferList = this.buffers.get(sessionId) || [];
    bufferList.push(audioData);
    this.buffers.set(sessionId, bufferList);
    this.totalSizes.set(sessionId, newSize);
    const metadataQueue = this.chunkMetadata.get(sessionId) || [];
    metadataQueue.push({
      audioLevel: metadata?.audioLevel,
      chunkId: metadata?.chunkId,
      size: audioData.length,
    });
    this.chunkMetadata.set(sessionId, metadataQueue);

    // Save chunk to disk for persistence
    await this.saveChunkToDisk(sessionId, audioData, mimeType);

    // Check if we need to process a chunk (every 30 seconds)
    if (!this.chunkTimers.has(sessionId)) {
      this.scheduleChunkProcessing(sessionId, mimeType);
    }
  }

  /**
   * Schedule chunk processing for real-time transcription
   */
  private scheduleChunkProcessing(sessionId: string, mimeType: string): void {
    const timer = setTimeout(async () => {
      await this.processChunk(sessionId, mimeType);
      this.chunkTimers.delete(sessionId);
      // Schedule next chunk if session still active (continuous real-time processing)
      if (this.buffers.has(sessionId)) {
        this.scheduleChunkProcessing(sessionId, mimeType);
      }
    }, CHUNK_DURATION_MS);

    this.chunkTimers.set(sessionId, timer);
  }

  /**
   * Process accumulated audio chunk and send to Gemini
   */
  private async processChunk(sessionId: string, mimeType: string): Promise<string | void> {
    const bufferList = this.buffers.get(sessionId);
    if (!bufferList || bufferList.length === 0) {
      // Don't log if session is already completed/cancelled (expected behavior)
      const session = await prisma.recordingSession.findUnique({
        where: { id: sessionId },
        select: { status: true },
      }).catch(() => null);
      
      if (session && (session.status === "COMPLETED" || session.status === "CANCELLED")) {
        // Session is done, this is expected - don't log
        return;
      }
      // Only log if session is still active
      return;
    }

    // Combine buffers into single chunk
    const combinedBuffer = Buffer.concat(bufferList);
    const totalSize = combinedBuffer.length;

    const metadataQueue = this.chunkMetadata.get(sessionId) || [];
    const currentMetadata = metadataQueue.splice(0, bufferList.length);
    this.chunkMetadata.set(sessionId, metadataQueue);
    const averageAudioLevel =
      currentMetadata.length > 0
        ? currentMetadata.reduce((sum, meta) => sum + (meta.audioLevel ?? 0), 0) /
          currentMetadata.length
        : null;
    
      // Skip processing if combined chunk is too small (likely silence/empty)
      // Increased threshold to ensure we have enough audio data for accurate transcription
      if (totalSize < MIN_CHUNK_SIZE_BYTES) {
        console.warn(`[AudioProcessor] Combined chunk too small for ${sessionId}: ${totalSize} bytes (likely silence, skipping transcription)`);
        // Clear buffers but don't process
        this.buffers.set(sessionId, []);
        this.chunkMetadata.set(sessionId, []);
        return;
      }

      if (averageAudioLevel !== null) {
        console.log(`[AudioProcessor] Average audio level for ${sessionId}: ${(averageAudioLevel * 100).toFixed(1)}%`);
      }

      if (
        averageAudioLevel !== null &&
        averageAudioLevel < 0.02 &&
        totalSize < MIN_CHUNK_SIZE_BYTES * 4
      ) {
        console.warn(
          `[AudioProcessor] Low audio energy detected (${averageAudioLevel}), skipping chunk for ${sessionId}`
        );
        this.buffers.set(sessionId, []);
        this.chunkMetadata.set(sessionId, []);
        return;
      }
      
      // Log audio quality metrics for debugging
      const audioDurationEstimate = (totalSize / (48000 * 2 * 2)) * 1000; // Rough estimate in ms (48kHz, 16-bit, stereo)
      console.log(`[AudioProcessor] Processing chunk: ${totalSize} bytes (~${Math.round(audioDurationEstimate)}ms of audio)`);

    let base64Audio = combinedBuffer.toString("base64");
    let finalMimeType = mimeType;
    console.log(`[AudioProcessor] Processing chunk for ${sessionId}: ${totalSize} bytes (${bufferList.length} sub-chunks), base64 length: ${base64Audio.length}`);

    const chunkHash = createHash("sha256").update(combinedBuffer).digest("hex");
    const previousHash = this.lastChunkHashes.get(sessionId);
    if (previousHash && previousHash === chunkHash) {
      console.warn(`[AudioProcessor] Duplicate chunk detected for ${sessionId} (hash=${chunkHash}). Skipping transcription.`);
      this.buffers.set(sessionId, []);
      this.chunkMetadata.set(sessionId, []);
      return;
    }
    this.lastChunkHashes.set(sessionId, chunkHash);

    // For WebM fragments from MediaRecorder, we need to use a special approach:
    // 1. Save chunks to temp files
    // 2. Use FFmpeg concat filter which properly handles fragmented WebM
    // This avoids EBML header parsing issues with concatenated buffers
    const isWebM = mimeType?.toLowerCase().includes("webm");
    const hasMultipleChunks = bufferList.length > 1;
    
    console.log(`[AudioProcessor] Conversion strategy: isWebM=${isWebM}, chunkCount=${bufferList.length}, mimeType=${mimeType}`);
    
    if (isWebM && hasMultipleChunks) {
      // For WebM with multiple chunks, ALWAYS use concat filter approach (handles fragments properly)
      console.log(`[AudioProcessor] Using concat filter method for WebM with ${bufferList.length} chunks`);
      try {
        const conversionResult = await this.convertWebMChunksWithConcatFilter(bufferList, mimeType, sessionId);
        base64Audio = conversionResult.base64Audio;
        finalMimeType = conversionResult.mimeType;
        console.log(`[AudioProcessor] ✅ Successfully converted WebM chunks using concat filter (${bufferList.length} chunks) to ${finalMimeType} for session ${sessionId}`);
      } catch (concatError) {
        console.error(`[AudioProcessor] ❌ Concat filter conversion failed for session ${sessionId}:`, (concatError as Error).message?.substring(0, 300));
        // If concat filter fails, try chunk-by-chunk conversion as fallback
        try {
          console.log(`[AudioProcessor] Trying chunk-by-chunk conversion as fallback...`);
          const conversionResult = await this.convertChunksToMp3(bufferList, mimeType, sessionId);
          base64Audio = conversionResult.base64Audio;
          finalMimeType = conversionResult.mimeType;
          console.log(`[AudioProcessor] ✅ Successfully converted chunks individually (${bufferList.length} chunks) to ${finalMimeType} for session ${sessionId}`);
        } catch (chunkConversionError) {
          console.error(`[AudioProcessor] ❌ Chunk-by-chunk conversion also failed for session ${sessionId}:`, (chunkConversionError as Error).message?.substring(0, 300));
          // Final fallback - this will likely fail with Gemini but we try anyway
          console.error(`[AudioProcessor] ⚠️ All conversion methods failed - using original WebM format (Gemini may reject this)`);
        }
      }
    } else if (isWebM && !hasMultipleChunks) {
      // Single WebM chunk - try pipe method
      console.log(`[AudioProcessor] Using pipe method for single WebM chunk`);
      try {
        const conversionResult = await this.convertBufferToMp3WithPipe(combinedBuffer, mimeType, sessionId);
        base64Audio = conversionResult.base64Audio;
        finalMimeType = conversionResult.mimeType;
        console.log(`[AudioProcessor] ✅ Successfully converted single WebM chunk using pipe method to ${finalMimeType} for session ${sessionId}`);
      } catch (conversionError) {
        console.error(`[AudioProcessor] ❌ Pipe conversion failed for single WebM chunk:`, (conversionError as Error).message?.substring(0, 300));
        console.error(`[AudioProcessor] ⚠️ Using original WebM format (Gemini may reject this)`);
      }
    } else {
      // For non-WebM formats, try pipe method first
      console.log(`[AudioProcessor] Using pipe method for non-WebM format: ${mimeType}`);
      try {
        const conversionResult = await this.convertBufferToMp3WithPipe(combinedBuffer, mimeType, sessionId);
        base64Audio = conversionResult.base64Audio;
        finalMimeType = conversionResult.mimeType;
        console.log(`[AudioProcessor] ✅ Successfully converted combined buffer (${totalSize} bytes) to ${finalMimeType} for session ${sessionId}`);
      } catch (conversionError) {
        console.warn(`[AudioProcessor] Pipe conversion failed for session ${sessionId}, trying chunk-by-chunk conversion:`, (conversionError as Error).message?.substring(0, 200));
        // Fall back to processing chunks individually
        try {
          const conversionResult = await this.convertChunksToMp3(bufferList, mimeType, sessionId);
          base64Audio = conversionResult.base64Audio;
          finalMimeType = conversionResult.mimeType;
          console.log(`[AudioProcessor] Successfully converted chunks individually (${bufferList.length} chunks) to ${finalMimeType} for session ${sessionId}`);
        } catch (chunkConversionError) {
          console.error(`[AudioProcessor] Chunk-by-chunk conversion also failed for session ${sessionId}, using original format:`, (chunkConversionError as Error).message?.substring(0, 200));
          // Final fallback to original format - let Gemini try to handle it
        }
      }
    }

    try {
      // Get previous transcript chunks for context continuity
      const session = await prisma.recordingSession.findUnique({
        where: { id: sessionId },
        include: { chunks: { orderBy: { chunkIndex: "asc" } } },
      });
      
      // Build previous context from recent chunks - use more chunks for better continuity
      let previousContext = "";
      if (session && session.chunks.length > 0) {
        // Use last 5 chunks for better context (with 30s chunks, this gives 2.5 minutes of context)
        const recentChunks = session.chunks.slice(-5);
        const contextTexts = recentChunks
          .map((chunk) => chunk.text.trim())
          .filter((text) => {
            // Only include chunks with actual speech (not just silence/inaudible)
            if (!text || text === "[silence]") return false;
            if (text.toLowerCase().includes("inaudible") && text.length < 30) return false;
            // Must have substantial content
            return text.length > 15;
          });
        
        // Only use context if we have at least one chunk with real speech
        if (contextTexts.length > 0) {
          // Join with newlines to preserve structure, limit to last 500 chars to avoid token limits
          previousContext = contextTexts.join("\n\n");
          if (previousContext.length > 500) {
            previousContext = previousContext.substring(previousContext.length - 500);
          }
        }
      }
      
      // Transcribe using Gemini with context
      const transcript = await transcribeAudio(base64Audio, finalMimeType, previousContext);

      // Save transcript chunk to database (session already fetched above)
      if (!session) {
        console.error(`[AudioProcessor] Session not found: ${sessionId}`);
        return;
      }

      // Double-check sessionId matches before saving
      if (session.id !== sessionId) {
        console.error(`Session ID mismatch! Expected ${sessionId}, got ${session.id}`);
        throw new Error(`Session ID mismatch when saving chunk`);
      }
      
      const chunk = await prisma.transcriptChunk.create({
        data: {
          sessionId, // Explicitly use the passed sessionId
          chunkIndex: session.chunks.length,
          text: transcript,
          timestamp: new Date(),
          confidence: averageAudioLevel ?? undefined,
        },
      });

      // Emit real-time transcript update to clients in the session room
      if (ioInstance && transcript.trim()) {
        const updateData = {
          sessionId,
          newChunk: {
            chunkIndex: chunk.chunkIndex,
            text: transcript,
            timestamp: chunk.timestamp.toISOString(),
          },
        };
        console.log(`[AudioProcessor] Emitting live-transcript-update to session ${sessionId}:`, updateData);
        ioInstance.to(sessionId).emit("live-transcript-update", updateData);
      } else {
        console.warn(`[AudioProcessor] Cannot emit transcript: ioInstance=${!!ioInstance}, transcriptLength=${transcript.trim().length}`);
      }

      // Clear processed buffers
      this.buffers.set(sessionId, []);
      this.chunkMetadata.set(sessionId, []);

      return transcript;
    } catch (error) {
      console.error(`Error processing chunk for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Save audio chunk to disk for crash recovery
   */
  private getChunkFilesForProcessing(sessionId: string, count: number): string[] {
    if (count <= 0) {
      return [];
    }
    const queue = this.chunkFileQueues.get(sessionId) || [];
    if (queue.length === 0) {
      return [];
    }
    const files = queue.splice(0, Math.min(count, queue.length));
    this.chunkFileQueues.set(sessionId, queue);
    return files;
  }

  private restoreChunkFiles(sessionId: string, files: string[]): void {
    if (!files || files.length === 0) {
      return;
    }
    const queue = this.chunkFileQueues.get(sessionId) || [];
    this.chunkFileQueues.set(sessionId, [...files, ...queue]);
  }

  private getExtensionForMime(mimeType: string): string {
    if (!mimeType) return "webm";
    const lower = mimeType.toLowerCase();
    if (lower.includes("ogg")) return "ogg";
    if (lower.includes("mp3") || lower.includes("mpeg")) return "mp3";
    if (lower.includes("wav")) return "wav";
    if (lower.includes("m4a") || lower.includes("mp4")) return "m4a";
    if (lower.includes("aac")) return "aac";
    return "webm";
  }

  /**
   * Convert chunk files from disk to MP3 using FFmpeg concat filter
   * This properly handles WebM fragments by extracting audio streams and concatenating them
   */
  private async convertChunkFilesToMp3(
    sessionId: string,
    chunkFiles: string[]
  ): Promise<{ base64Audio: string; mimeType: string }> {
    if (chunkFiles.length === 0) {
      throw new Error("No chunk files provided for conversion");
    }

    const tempDir = await mkdtemp(join(tmpdir(), `session-${sessionId}-`));
    const outputFile = join(tempDir, `combined-${Date.now()}.mp3`);
    
    // Build FFmpeg command with multiple inputs and concat filter
    // This approach handles fragmented WebM better than concat demuxer
    const inputArgs = chunkFiles.map((file) => `-i "${file}"`).join(" ");
    
    // Build concat filter: [0:a] [1:a] [2:a] ... concat=n=N:v=0:a=1 [outa]
    // This extracts audio from each input and concatenates them
    const audioInputs = chunkFiles.map((_, i) => `[${i}:a]`).join(" ");
    const concatFilter = `${audioInputs} concat=n=${chunkFiles.length}:v=0:a=1 [outa]`;
    
    // Use -err_detect ignore_err and -fflags +genpts to handle fragmented streams
    const ffmpegCommand = `ffmpeg -y -loglevel warning -err_detect ignore_err -fflags +genpts ${inputArgs} -filter_complex "${concatFilter}" -map "[outa]" -acodec libmp3lame -ar 16000 -ac 1 -b:a 64k -f mp3 "${outputFile}"`;

    try {
      const { stdout, stderr } = await execAsync(ffmpegCommand, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60000,
      });

      // Verify output file
      if (!existsSync(outputFile)) {
        throw new Error("FFmpeg concat failed - output file not created");
      }

      const stats = await stat(outputFile);
      if (stats.size === 0) {
        throw new Error("FFmpeg concat produced empty file");
      }

      const mp3Buffer = await readFile(outputFile);
      console.log(`[AudioProcessor] Combined ${chunkFiles.length} chunks into ${stats.size} byte MP3 (${(stats.size / 1024).toFixed(1)} KB)`);

      // Verify duration using ffprobe if available
      try {
        const { stdout: durationOut } = await execAsync(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputFile}"`,
          {
            maxBuffer: 1024 * 1024,
            timeout: 10000,
          }
        );
        const duration = parseFloat(durationOut.trim());
        console.log(`[AudioProcessor] MP3 duration: ${duration.toFixed(2)} seconds (expected ~30s)`);
        if (duration < 5) {
          console.warn(
            `[AudioProcessor] ⚠️ WARNING: MP3 is only ${duration.toFixed(2)}s, expected ~30s. Audio may be truncated.`
          );
        } else if (duration >= 25 && duration <= 35) {
          console.log(`[AudioProcessor] ✅ MP3 duration is correct: ${duration.toFixed(2)}s`);
        }
      } catch (probeError) {
        // ffprobe not available or failed, continue anyway
        console.warn(`[AudioProcessor] Could not verify MP3 duration: ${probeError}`);
      }

      const base64Audio = mp3Buffer.toString("base64");

      if (SAVE_MP3_DEBUG) {
        await this.saveDebugMp3(sessionId, mp3Buffer);
      }

      // Remove processed chunk files to keep disk usage low
      await Promise.all(chunkFiles.map((filePath) => unlink(filePath).catch(() => {})));

      return { base64Audio, mimeType: "audio/mp3" };
    } catch (error: any) {
      console.error(`[AudioProcessor] FFmpeg concat filter failed:`, error.message?.substring(0, 300));
      // Log stderr if available for debugging
      if (error.stderr) {
        console.error(`[AudioProcessor] FFmpeg stderr:`, error.stderr.substring(0, 500));
      }
      throw error;
    } finally {
      // Clean up temp directory (but keep debug MP3 if saved)
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Convert WebM chunks using FFmpeg concat filter
   * This is the most reliable method for fragmented WebM from MediaRecorder
   * It saves chunks to disk and uses concat filter to handle fragments properly
   */
  private async convertWebMChunksWithConcatFilter(
    bufferChunks: Buffer[],
    inputMimeType: string,
    sessionId: string
  ): Promise<{ base64Audio: string; mimeType: string }> {
    if (bufferChunks.length === 0) {
      throw new Error("No chunks provided for conversion");
    }

    const tempDir = await mkdtemp(join(tmpdir(), `session-${sessionId}-`));
    const chunkFiles: string[] = [];

    try {
      // Step 1: Save each chunk to disk as WebM file
      for (let i = 0; i < bufferChunks.length; i++) {
        const chunk = bufferChunks[i];
        const chunkFile = join(tempDir, `chunk-${i}.${this.getExtensionForMime(inputMimeType)}`);
        await writeFile(chunkFile, chunk);
        chunkFiles.push(chunkFile);
      }

      const outputFile = join(tempDir, `combined-${Date.now()}.mp3`);

      // Step 2: Use FFmpeg concat filter to concatenate WebM chunks and convert to MP3
      // This approach handles fragmented WebM properly by extracting audio streams
      // The concat filter can handle fragments even without complete headers
      // Build input arguments - specify format and error handling for each input
      // Each input needs its own format specification for fragmented WebM
      const inputArgs: string[] = [];
      for (const file of chunkFiles) {
        inputArgs.push("-f", "webm", "-err_detect", "ignore_err", "-fflags", "+genpts", "-i", file);
      }
      const inputArgsStr = inputArgs.join(" ");
      
      // Build concat filter: [0:a] [1:a] [2:a] ... concat=n=N:v=0:a=1 [outa]
      // This extracts audio from each input and concatenates them
      const audioInputs = chunkFiles.map((_, i) => `[${i}:a]`).join(" ");
      const concatFilter = `${audioInputs} concat=n=${chunkFiles.length}:v=0:a=1 [outa]`;
      
      // Use concat filter to combine audio streams and convert to MP3
      // Note: We don't quote file paths in the array, but we do quote the output file
      const ffmpegCommand = `ffmpeg -y -loglevel warning ${inputArgsStr} -filter_complex "${concatFilter}" -map "[outa]" -acodec libmp3lame -ar 16000 -ac 1 -b:a 64k -f mp3 "${outputFile}"`;
      
      console.log(`[AudioProcessor] FFmpeg command for concat filter: ffmpeg -y -loglevel warning [${chunkFiles.length} inputs] -filter_complex "${concatFilter}" ...`);

      const { stdout, stderr } = await execAsync(ffmpegCommand, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60000,
      });

      // Verify output file
      if (!existsSync(outputFile)) {
        throw new Error("FFmpeg concat filter failed - output file not created");
      }

      const stats = await stat(outputFile);
      if (stats.size === 0) {
        throw new Error("FFmpeg concat filter produced empty file");
      }

      const mp3Buffer = await readFile(outputFile);
      console.log(`[AudioProcessor] Converted ${chunkFiles.length} WebM chunks into ${stats.size} byte MP3 (${(stats.size / 1024).toFixed(1)} KB)`);

      // Verify duration using ffprobe if available
      try {
        const { stdout: durationOut } = await execAsync(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputFile}"`,
          {
            maxBuffer: 1024 * 1024,
            timeout: 10000,
          }
        );
        const duration = parseFloat(durationOut.trim());
        console.log(`[AudioProcessor] MP3 duration: ${duration.toFixed(2)} seconds (expected ~30s)`);
        if (duration < 5) {
          console.warn(
            `[AudioProcessor] ⚠️ WARNING: MP3 is only ${duration.toFixed(2)}s, expected ~30s. Audio may be truncated.`
          );
        } else if (duration >= 25 && duration <= 35) {
          console.log(`[AudioProcessor] ✅ MP3 duration is correct: ${duration.toFixed(2)}s`);
        }
      } catch (probeError) {
        // ffprobe not available or failed, continue anyway
        console.warn(`[AudioProcessor] Could not verify MP3 duration: ${probeError}`);
      }

      const base64Audio = mp3Buffer.toString("base64");

      if (SAVE_MP3_DEBUG) {
        await this.saveDebugMp3(sessionId, mp3Buffer);
      }

      return { base64Audio, mimeType: "audio/mp3" };
    } catch (error: any) {
      console.error(`[AudioProcessor] WebM concat filter conversion failed:`, error.message?.substring(0, 300));
      // Log stderr if available for debugging
      if (error.stderr) {
        console.error(`[AudioProcessor] FFmpeg stderr:`, error.stderr.substring(0, 500));
      }
      throw error;
    } finally {
      // Clean up temp directory (but keep debug MP3 if saved)
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Convert combined buffer to MP3 using FFmpeg pipe input
   * This handles fragmented WebM by streaming the data directly to FFmpeg
   */
  private async convertBufferToMp3WithPipe(
    audioBuffer: Buffer,
    inputMimeType: string,
    sessionId: string
  ): Promise<{ base64Audio: string; mimeType: string }> {
    const tempDir = await mkdtemp(join(tmpdir(), `session-${sessionId}-`));
    const outputFile = join(tempDir, `output-${Date.now()}.mp3`);

    return new Promise((resolve, reject) => {
      // Use pipe input to stream the buffer directly to FFmpeg
      // This allows FFmpeg to handle fragmented WebM streams properly
      const isWebM = inputMimeType?.toLowerCase().includes("webm");
      const ffmpegArgs = [
        "-y",
        "-loglevel", "warning",
        ...(isWebM ? ["-f", "webm"] : []), // Add format flag as separate arguments if WebM
        "-err_detect", "ignore_err",
        "-fflags", "+genpts",
        "-i", "pipe:0", // Read from stdin
        "-acodec", "libmp3lame",
        "-ar", "16000",
        "-ac", "1",
        "-b:a", "64k",
        "-f", "mp3",
        outputFile
      ];

      const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stderr = "";
      let ffmpegExited = false;

      ffmpeg.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      // Handle stdin errors (EPIPE when FFmpeg exits early)
      ffmpeg.stdin.on("error", (error: any) => {
        if (error.code === "EPIPE" && !ffmpegExited) {
          // FFmpeg closed stdin early, wait for it to finish
          console.warn(`[AudioProcessor] FFmpeg stdin closed early (EPIPE), waiting for process to complete...`);
          return;
        }
        if (!ffmpegExited) {
          reject(new Error(`FFmpeg stdin error: ${error.message}`));
        }
      });

      ffmpeg.on("error", (error) => {
        if (!ffmpegExited) {
          ffmpegExited = true;
          reject(new Error(`FFmpeg spawn failed: ${error.message}`));
        }
      });

      ffmpeg.on("close", async (code) => {
        ffmpegExited = true;
        
        if (code !== 0) {
          await rm(tempDir, { recursive: true, force: true }).catch(() => {});
          reject(new Error(`FFmpeg conversion failed with code ${code}: ${stderr.substring(0, 300)}`));
          return;
        }

        try {
          if (!existsSync(outputFile)) {
            throw new Error("FFmpeg conversion failed - output file not created");
          }

          const stats = await stat(outputFile);
          if (stats.size === 0) {
            throw new Error("FFmpeg conversion produced empty file");
          }

          const mp3Buffer = await readFile(outputFile);
          console.log(`[AudioProcessor] Converted ${audioBuffer.length} bytes to ${stats.size} byte MP3 (${(stats.size / 1024).toFixed(1)} KB)`);

          // Verify duration using ffprobe if available
          try {
            const { stdout: durationOut } = await execAsync(
              `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputFile}"`,
              {
                maxBuffer: 1024 * 1024,
                timeout: 10000,
              }
            );
            const duration = parseFloat(durationOut.trim());
            console.log(`[AudioProcessor] MP3 duration: ${duration.toFixed(2)} seconds (expected ~30s)`);
            if (duration < 5) {
              console.warn(
                `[AudioProcessor] ⚠️ WARNING: MP3 is only ${duration.toFixed(2)}s, expected ~30s. Audio may be truncated.`
              );
            } else if (duration >= 25 && duration <= 35) {
              console.log(`[AudioProcessor] ✅ MP3 duration is correct: ${duration.toFixed(2)}s`);
            }
          } catch (probeError) {
            // ffprobe not available or failed, continue anyway
            console.warn(`[AudioProcessor] Could not verify MP3 duration: ${probeError}`);
          }

          const base64Audio = mp3Buffer.toString("base64");

          if (SAVE_MP3_DEBUG) {
            await this.saveDebugMp3(sessionId, mp3Buffer);
          }

          // Clean up temp directory
          await rm(tempDir, { recursive: true, force: true }).catch(() => {});

          resolve({ base64Audio, mimeType: "audio/mp3" });
        } catch (error: any) {
          await rm(tempDir, { recursive: true, force: true }).catch(() => {});
          reject(error);
        }
      });

      // Write buffer to FFmpeg stdin with error handling
      try {
        if (!ffmpeg.stdin.destroyed && !ffmpegExited) {
          ffmpeg.stdin.write(audioBuffer, (error) => {
            if (error && (error as any).code !== "EPIPE" && !ffmpegExited) {
              console.error(`[AudioProcessor] Error writing to FFmpeg stdin:`, error.message);
            }
          });
          ffmpeg.stdin.end();
        }
      } catch (error: any) {
        if (error?.code !== "EPIPE" && !ffmpegExited) {
          console.error(`[AudioProcessor] Error writing to FFmpeg stdin:`, error?.message || String(error));
        }
      }
    });
  }

  /**
   * Convert individual buffer chunks to MP3, then concatenate
   * This handles WebM fragments by processing each chunk individually to extract audio
   */
  private async convertChunksToMp3(
    bufferChunks: Buffer[],
    inputMimeType: string,
    sessionId: string
  ): Promise<{ base64Audio: string; mimeType: string }> {
    if (bufferChunks.length === 0) {
      throw new Error("No chunks provided for conversion");
    }

    const tempDir = await mkdtemp(join(tmpdir(), `session-${sessionId}-`));
    const convertedChunks: string[] = [];

    try {
      // Step 1: Convert each chunk individually to MP3
      // Each chunk (even fragments) can be processed separately to extract audio stream
      for (let i = 0; i < bufferChunks.length; i++) {
        const chunk = bufferChunks[i];
        const inputChunk = join(tempDir, `chunk-${i}-input.${this.getExtensionForMime(inputMimeType)}`);
        const outputChunk = join(tempDir, `chunk-${i}.mp3`);

        await writeFile(inputChunk, chunk);

        // Convert individual chunk to MP3 - extract audio stream from fragment
        // Use -f webm to force format, -err_detect ignore_err for fragments
        // -fflags +genpts generates timestamps for streamed content
        const isWebM = inputMimeType?.toLowerCase().includes("webm");
        const formatFlag = isWebM ? "-f webm" : "";
        const convertCommand = `ffmpeg -y -loglevel error ${formatFlag} -err_detect ignore_err -fflags +genpts -i "${inputChunk}" -acodec libmp3lame -ar 16000 -ac 1 -b:a 64k -f mp3 "${outputChunk}"`;

        try {
          await execAsync(convertCommand, {
            maxBuffer: 10 * 1024 * 1024,
            timeout: 30000,
          });

          if (existsSync(outputChunk)) {
            const stats = await stat(outputChunk);
            if (stats.size > 0) {
              convertedChunks.push(outputChunk);
            }
          }
        } catch (error: any) {
          // Skip invalid chunks - continue with others
          console.warn(`[AudioProcessor] Failed to convert chunk ${i + 1}/${bufferChunks.length}, skipping: ${error.message?.substring(0, 100)}`);
        } finally {
          // Clean up input chunk file
          await unlink(inputChunk).catch(() => {});
        }
      }

      if (convertedChunks.length === 0) {
        throw new Error("No chunks were successfully converted to MP3");
      }

      console.log(`[AudioProcessor] Successfully converted ${convertedChunks.length}/${bufferChunks.length} chunks to MP3`);

      // Step 2: Concatenate all MP3 chunks using concat demuxer
      const concatListPath = join(tempDir, "chunks.txt");
      const concatContent = convertedChunks
        .map((filePath) => `file '${filePath.replace(/'/g, "'\\''")}'`)
        .join("\n");
      await writeFile(concatListPath, concatContent);

      const outputFile = join(tempDir, `combined-${Date.now()}.mp3`);
      // Use concat demuxer for MP3 files (MP3s are complete files, not fragments)
      const ffmpegCommand = `ffmpeg -y -loglevel warning -f concat -safe 0 -i "${concatListPath}" -acodec copy "${outputFile}"`;

      const { stdout, stderr } = await execAsync(ffmpegCommand, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60000,
      });

      if (!existsSync(outputFile)) {
        throw new Error("FFmpeg concat failed - output file not created");
      }

      const stats = await stat(outputFile);
      if (stats.size === 0) {
        throw new Error("FFmpeg concat produced empty file");
      }

      const mp3Buffer = await readFile(outputFile);
      console.log(`[AudioProcessor] Combined ${convertedChunks.length} MP3 chunks into ${stats.size} byte MP3 (${(stats.size / 1024).toFixed(1)} KB)`);

      // Verify duration using ffprobe if available
      try {
        const { stdout: durationOut } = await execAsync(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputFile}"`,
          {
            maxBuffer: 1024 * 1024,
            timeout: 10000,
          }
        );
        const duration = parseFloat(durationOut.trim());
        console.log(`[AudioProcessor] MP3 duration: ${duration.toFixed(2)} seconds (expected ~30s)`);
        if (duration < 5) {
          console.warn(
            `[AudioProcessor] ⚠️ WARNING: MP3 is only ${duration.toFixed(2)}s, expected ~30s. Audio may be truncated.`
          );
        } else if (duration >= 25 && duration <= 35) {
          console.log(`[AudioProcessor] ✅ MP3 duration is correct: ${duration.toFixed(2)}s`);
        }
      } catch (probeError) {
        // ffprobe not available or failed, continue anyway
        console.warn(`[AudioProcessor] Could not verify MP3 duration: ${probeError}`);
      }

      const base64Audio = mp3Buffer.toString("base64");

      if (SAVE_MP3_DEBUG) {
        await this.saveDebugMp3(sessionId, mp3Buffer);
      }

      return { base64Audio, mimeType: "audio/mp3" };
    } catch (error: any) {
      console.error(`[AudioProcessor] Chunk conversion failed:`, error.message?.substring(0, 300));
      throw error;
    } finally {
      // Clean up temp directory (but keep debug MP3 if saved)
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async saveChunkToDisk(sessionId: string, audioData: Buffer, mimeType: string = "audio/webm"): Promise<void> {
    const audioDir = this.getSessionDir(sessionId);
    if (!existsSync(audioDir)) {
      await mkdir(audioDir, { recursive: true });
    }

    const timestamp = Date.now();
    const extension = this.getExtensionForMime(mimeType);
    const filePath = join(audioDir, `chunk-${timestamp}.${extension}`);
    await writeFile(filePath, audioData);

    const queue = this.chunkFileQueues.get(sessionId) || [];
    queue.push(filePath);
    this.chunkFileQueues.set(sessionId, queue);
  }

  private async saveDebugMp3(sessionId: string, mp3Buffer: Buffer): Promise<void> {
    try {
      const sessionDir = this.getSessionDir(sessionId);
      if (!existsSync(sessionDir)) {
        await mkdir(sessionDir, { recursive: true });
      }

      const debugDir = join(sessionDir, "debug");
      if (!existsSync(debugDir)) {
        await mkdir(debugDir, { recursive: true });
      }

      const filePath = join(debugDir, `combined-${Date.now()}.mp3`);
      await writeFile(filePath, mp3Buffer);
      console.log(`[AudioProcessor] Saved debug MP3 for ${sessionId}: ${filePath}`);
    } catch (error) {
      console.error(`[AudioProcessor] Failed to save debug MP3 for ${sessionId}:`, error);
    }
  }

  /**
   * Stop recording and generate final summary
   */
  async stopRecording(sessionId: string): Promise<{ transcript: string; summary: string }> {
    // Process any remaining chunks
    const bufferList = this.buffers.get(sessionId);
    if (bufferList && bufferList.length > 0) {
      await this.processChunk(sessionId, "audio/webm");
    }

    // Clear timers and buffers
    const timer = this.chunkTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.chunkTimers.delete(sessionId);
    }
    
    // Clear buffers to prevent "No buffers to process" messages
    this.buffers.delete(sessionId);
    this.sessionStartTimes.delete(sessionId);
    this.totalSizes.delete(sessionId);
    this.chunkFileQueues.delete(sessionId);
    this.chunkMetadata.delete(sessionId);
    this.lastChunkHashes.delete(sessionId);

    // Update session status to processing
    await prisma.recordingSession.update({
      where: { id: sessionId },
      data: { status: SessionStatus.PROCESSING },
    });

    // Get all transcript chunks
    const session = await prisma.recordingSession.findUnique({
      where: { id: sessionId },
      include: { chunks: { orderBy: { chunkIndex: "asc" } } },
    });

    if (!session) {
      throw new Error("Session not found");
    }

    // Filter chunks to ensure they belong to this session (safety check)
    const validChunks = session.chunks
      .filter((chunk) => chunk.sessionId === sessionId)
      .map((chunk) => chunk.text.trim())
      .filter((text) => {
        // Filter out empty chunks and error messages
        if (!text || text.length === 0) return false;
        const lowerText = text.toLowerCase();
        if (
          lowerText.includes("the audio appears to be silent") ||
          lowerText.includes("cannot provide a transcription") ||
          lowerText.includes("no discernible speech") ||
          lowerText.includes("okay, here's the transcription")
        ) {
          return false;
        }
        return true;
      });

    // Combine all valid chunks into full transcript
    const fullTranscript = validChunks.join("\n\n");

    // Generate summary
    const summary = await generateSummary(fullTranscript);

    // Calculate duration
    const startTime = this.sessionStartTimes.get(sessionId);
    const duration = startTime ? Math.floor((Date.now() - startTime) / 1000) : null;

    // Update session with final data
    await prisma.recordingSession.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.COMPLETED,
        transcriptText: fullTranscript,
        summary,
        duration,
      },
    });

    // Cleanup buffers and audio files
    this.buffers.delete(sessionId);
    this.sessionStartTimes.delete(sessionId);
    this.totalSizes.delete(sessionId);
    
    // Clean up audio files after processing is complete
    await this.cleanupAudioFiles(sessionId);

    return { transcript: fullTranscript, summary };
  }

  /**
   * Pause recording
   */
  async pauseRecording(sessionId: string): Promise<void> {
    const timer = this.chunkTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.chunkTimers.delete(sessionId);
    }

    await prisma.recordingSession.update({
      where: { id: sessionId },
      data: { status: SessionStatus.PAUSED },
    });
  }

  /**
   * Resume recording
   */
  async resumeRecording(sessionId: string, mimeType: string = "audio/webm"): Promise<void> {
    await prisma.recordingSession.update({
      where: { id: sessionId },
      data: { status: SessionStatus.RECORDING },
    });

    // Resume chunk processing
    this.scheduleChunkProcessing(sessionId, mimeType);
  }

  /**
   * Cancel recording
   */
  async cancelRecording(sessionId: string): Promise<void> {
    console.log(`[AudioProcessor] Cancelling recording for session ${sessionId}`);
    
    // Clear all data immediately to prevent any further processing
    this.buffers.delete(sessionId);
    
    const timer = this.chunkTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
    }
    this.chunkTimers.delete(sessionId);
    this.sessionStartTimes.delete(sessionId);
    this.totalSizes.delete(sessionId);
    this.chunkFileQueues.delete(sessionId);
    this.chunkMetadata.delete(sessionId);
    this.lastChunkHashes.delete(sessionId);

    // Clean up audio files
    await this.cleanupAudioFiles(sessionId);

    // Update session status to CANCELLED
    try {
      await prisma.recordingSession.update({
        where: { id: sessionId },
        data: { status: SessionStatus.CANCELLED },
      });
      console.log(`[AudioProcessor] Session ${sessionId} marked as CANCELLED`);
    } catch (error) {
      console.error(`[AudioProcessor] Error updating session status:`, error);
    }
  }
  
  /**
   * Clean up audio files for a session
   * Preserves debug MP3s if SAVE_MP3_DEBUG is enabled
   */
  private async cleanupAudioFiles(sessionId: string): Promise<void> {
    try {
      const audioDir = this.getSessionDir(sessionId);
      if (existsSync(audioDir)) {
        // If debug mode is enabled, preserve debug MP3s by moving them to a persistent location
        if (SAVE_MP3_DEBUG) {
          const debugDir = join(audioDir, "debug");
          if (existsSync(debugDir)) {
            const debugFiles = await readdir(debugDir);
            if (debugFiles.length > 0) {
              // Create a persistent debug directory outside the session folder
              const persistentDebugDir = join(AUDIO_SESSIONS_ROOT, "..", "debug_mp3s");
              if (!existsSync(persistentDebugDir)) {
                await mkdir(persistentDebugDir, { recursive: true });
              }
              
              // Move debug MP3s to persistent location
              for (const file of debugFiles) {
                if (file.endsWith(".mp3")) {
                  const sourcePath = join(debugDir, file);
                  const destPath = join(persistentDebugDir, `${sessionId}-${file}`);
                  try {
                    await readFile(sourcePath).then(data => writeFile(destPath, data));
                    console.log(`[AudioProcessor] Preserved debug MP3: ${destPath}`);
                  } catch (error) {
                    console.error(`[AudioProcessor] Failed to preserve debug MP3 ${file}:`, error);
                  }
                }
              }
            }
          }
        }
        
        // Now remove the session directory (debug files already preserved if needed)
        await rm(audioDir, { recursive: true, force: true });
        console.log(`[AudioProcessor] Cleaned up audio files for session ${sessionId}`);
      }
      this.chunkFileQueues.delete(sessionId);
      this.chunkMetadata.delete(sessionId);
      this.lastChunkHashes.delete(sessionId);
    } catch (error) {
      console.error(`[AudioProcessor] Error cleaning up audio files for ${sessionId}:`, error);
    }
  }
  
  /**
   * Resume processing for sessions that were interrupted (crash recovery)
   * Called on server startup to recover from crashes
   */
  async resumeInterruptedSessions(): Promise<void> {
    try {
      const sessionsDir = AUDIO_SESSIONS_ROOT;
      if (!existsSync(sessionsDir)) {
        console.log("[AudioProcessor] No sessions directory found, nothing to resume");
        return;
      }

      const sessionDirs = await readdir(sessionsDir, { withFileTypes: true });
      console.log(`[AudioProcessor] Checking ${sessionDirs.length} session directories for recovery...`);

      for (const dir of sessionDirs) {
        if (!dir.isDirectory()) continue;

        const sessionId = dir.name;
        const sessionDir = this.getSessionDir(sessionId);

        try {
          // Check if session exists in database and is still active
          const session = await prisma.recordingSession.findUnique({
            where: { id: sessionId },
            include: { chunks: true },
          });

          if (!session) {
            console.log(`[AudioProcessor] Session ${sessionId} not found in DB, skipping recovery`);
            continue;
          }

          // Only resume if session is RECORDING or PROCESSING
          if (session.status !== "RECORDING" && session.status !== "PROCESSING") {
            console.log(`[AudioProcessor] Session ${sessionId} is ${session.status}, skipping recovery`);
            continue;
          }

          // Read all chunk files from disk
          const files = await readdir(sessionDir);
          const chunkFiles = files
            .filter((f) => f.startsWith("chunk-") && f.match(/\.(webm|ogg|mp3|m4a|aac|wav)$/))
            .sort(); // Sort by filename (timestamp)

          if (chunkFiles.length === 0) {
            console.log(`[AudioProcessor] No chunk files found for session ${sessionId}`);
            continue;
          }

          console.log(`[AudioProcessor] Resuming session ${sessionId}: ${chunkFiles.length} chunks found`);

          // Rebuild buffers from disk
          const buffers: Buffer[] = [];
          let totalSize = 0;
          const chunkFilePaths: string[] = [];

          for (const file of chunkFiles) {
            const filePath = join(sessionDir, file);
            const chunkData = await readFile(filePath);
            buffers.push(chunkData);
            totalSize += chunkData.length;
            chunkFilePaths.push(filePath);
          }

          // Restore session state
          this.buffers.set(sessionId, buffers);
          this.totalSizes.set(sessionId, totalSize);
          this.sessionStartTimes.set(sessionId, new Date(session.createdAt).getTime());
          this.chunkFileQueues.set(sessionId, chunkFilePaths);
          this.chunkMetadata.set(
            sessionId,
            chunkFilePaths.map(() => ({ size: 0 }))
          );

          // If session was PROCESSING, continue processing
          if (session.status === "PROCESSING") {
            // Process remaining chunks
            await this.processChunk(sessionId, "audio/webm");
          } else {
            // If RECORDING, resume chunk processing schedule
            this.scheduleChunkProcessing(sessionId, "audio/webm");
          }

          console.log(`[AudioProcessor] Successfully resumed session ${sessionId}`);
        } catch (error) {
          console.error(`[AudioProcessor] Error resuming session ${sessionId}:`, error);
        }
      }

      console.log("[AudioProcessor] Crash recovery check complete");
    } catch (error) {
      console.error("[AudioProcessor] Error during crash recovery:", error);
    }
  }

  /**
   * Clean up old audio files (older than 7 days)
   */
  async cleanupOldAudioFiles(): Promise<void> {
    try {
      const sessionsDir = AUDIO_SESSIONS_ROOT;
      if (!existsSync(sessionsDir)) {
        return;
      }
      
      const sessionDirs = await readdir(sessionsDir, { withFileTypes: true });
      const now = Date.now();
      const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
      
      for (const dir of sessionDirs) {
        if (dir.isDirectory()) {
          const dirPath = join(sessionsDir, dir.name);
          const stats = await stat(dirPath);
          
          if (stats.mtimeMs < sevenDaysAgo) {
            await rm(dirPath, { recursive: true, force: true });
            console.log(`[AudioProcessor] Cleaned up old audio files: ${dir.name}`);
          }
        }
      }
    } catch (error) {
      console.error(`[AudioProcessor] Error cleaning up old audio files:`, error);
    }
  }
}

export const audioProcessor = new AudioProcessor();

