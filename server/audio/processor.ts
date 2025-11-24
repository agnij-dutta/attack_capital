import { PrismaClient, SessionStatus } from "@prisma/client";
import { transcribeAudio, generateSummary } from "../lib/gemini";
import { writeFile, mkdir, rm, readdir, stat, readFile, mkdtemp, unlink } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import dotenv from "dotenv";
import { Server as SocketIOServer } from "socket.io";
import { tmpdir } from "os";
import { exec } from "child_process";
import { promisify } from "util";

dotenv.config();

const prisma = new PrismaClient();
const CHUNK_DURATION_MS = 30000; // 30 seconds as per PRD requirement - longer chunks provide better context
const MIN_CHUNK_SIZE_BYTES = 10000; // Minimum chunk size to process (10KB) - larger chunks = better accuracy
const MAX_BUFFER_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

const execAsync = promisify(exec);

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

  /**
   * Initialize a new recording session
   */
  async initializeSession(sessionId: string, userId: string): Promise<void> {
    this.buffers.set(sessionId, []);
    this.sessionStartTimes.set(sessionId, Date.now());
    this.totalSizes.set(sessionId, 0);
    this.chunkFileQueues.set(sessionId, []);

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
    mimeType: string = "audio/webm"
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
  private async processChunk(sessionId: string, mimeType: string): Promise<void> {
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
    
      // Skip processing if combined chunk is too small (likely silence/empty)
      // Increased threshold to ensure we have enough audio data for accurate transcription
      if (totalSize < MIN_CHUNK_SIZE_BYTES) {
        console.warn(`[AudioProcessor] Combined chunk too small for ${sessionId}: ${totalSize} bytes (likely silence, skipping transcription)`);
        // Clear buffers but don't process
        this.buffers.set(sessionId, []);
        return;
      }
      
      // Log audio quality metrics for debugging
      const audioDurationEstimate = (totalSize / (48000 * 2 * 2)) * 1000; // Rough estimate in ms (48kHz, 16-bit, stereo)
      console.log(`[AudioProcessor] Processing chunk: ${totalSize} bytes (~${Math.round(audioDurationEstimate)}ms of audio)`);

    let base64Audio = combinedBuffer.toString("base64");
    let finalMimeType = mimeType;
    console.log(`[AudioProcessor] Processing chunk for ${sessionId}: ${totalSize} bytes (${bufferList.length} sub-chunks), base64 length: ${base64Audio.length}`);

    // Convert using disk chunks to ensure proper container (prevents EBML header errors)
    const chunkFiles = this.getChunkFilesForProcessing(sessionId, bufferList.length);
    if (chunkFiles.length > 0) {
      if (chunkFiles.length === bufferList.length) {
        try {
          const conversionResult = await this.convertChunksToMp3(sessionId, chunkFiles);
          base64Audio = conversionResult.base64Audio;
          finalMimeType = conversionResult.mimeType;
          console.log(`[AudioProcessor] Successfully converted ${chunkFiles.length} chunk files to ${finalMimeType} for session ${sessionId}`);
        } catch (conversionError) {
          console.error(`[AudioProcessor] Failed to convert chunk files for session ${sessionId}, falling back to in-memory buffer:`, conversionError);
          this.restoreChunkFiles(sessionId, chunkFiles);
        }
      } else {
        console.warn(`[AudioProcessor] Chunk file count mismatch for session ${sessionId}. Expected ${bufferList.length}, got ${chunkFiles.length}. Restoring files and falling back to in-memory buffer.`);
        this.restoreChunkFiles(sessionId, chunkFiles);
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

  private async convertChunksToMp3(sessionId: string, chunkFiles: string[]): Promise<{ base64Audio: string; mimeType: string }> {
    if (chunkFiles.length === 0) {
      throw new Error("No chunk files provided for conversion");
    }

    const tempDir = await mkdtemp(join(tmpdir(), `session-${sessionId}-`));
    const concatListPath = join(tempDir, "chunks.txt");
    const concatContent = chunkFiles
      .map((filePath) => `file '${filePath.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await writeFile(concatListPath, concatContent);

    const outputFile = join(tempDir, `combined-${Date.now()}.mp3`);
    const ffmpegCommand = `ffmpeg -y -loglevel error -f concat -safe 0 -i "${concatListPath}" -acodec libmp3lame -ar 16000 -ac 1 -b:a 64k "${outputFile}"`;

    try {
      await execAsync(ffmpegCommand, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60000,
      });
      const mp3Buffer = await readFile(outputFile);
      if (!mp3Buffer || mp3Buffer.length === 0) {
        throw new Error("Converted MP3 is empty");
      }
      const base64Audio = mp3Buffer.toString("base64");

      // Remove processed chunk files to keep disk usage low
      await Promise.all(chunkFiles.map((filePath) => unlink(filePath).catch(() => {})));

      return { base64Audio, mimeType: "audio/mp3" };
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async saveChunkToDisk(sessionId: string, audioData: Buffer, mimeType: string = "audio/webm"): Promise<void> {
    const audioDir = join(process.cwd(), "server", "audio", "sessions", sessionId);
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
   */
  private async cleanupAudioFiles(sessionId: string): Promise<void> {
    try {
      const audioDir = join(process.cwd(), "server", "audio", "sessions", sessionId);
      if (existsSync(audioDir)) {
        await rm(audioDir, { recursive: true, force: true });
        console.log(`[AudioProcessor] Cleaned up audio files for session ${sessionId}`);
      }
      this.chunkFileQueues.delete(sessionId);
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
      const sessionsDir = join(process.cwd(), "server", "audio", "sessions");
      if (!existsSync(sessionsDir)) {
        console.log("[AudioProcessor] No sessions directory found, nothing to resume");
        return;
      }

      const sessionDirs = await readdir(sessionsDir, { withFileTypes: true });
      console.log(`[AudioProcessor] Checking ${sessionDirs.length} session directories for recovery...`);

      for (const dir of sessionDirs) {
        if (!dir.isDirectory()) continue;

        const sessionId = dir.name;
        const sessionDir = join(sessionsDir, sessionId);

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
      const sessionsDir = join(process.cwd(), "server", "audio", "sessions");
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

