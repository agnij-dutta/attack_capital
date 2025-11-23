import { PrismaClient, SessionStatus } from "@prisma/client";
import { transcribeAudio, generateSummary } from "../lib/gemini";
import { writeFile, mkdir, rm, readdir, stat } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import dotenv from "dotenv";
import { Server as SocketIOServer } from "socket.io";

dotenv.config();

const prisma = new PrismaClient();
const CHUNK_DURATION_MS = 5000; // 5 seconds for better real-time transcription and accuracy
const MIN_CHUNK_SIZE_BYTES = 5000; // Minimum chunk size to process (5KB) - larger chunks = better accuracy
const MAX_BUFFER_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

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

  /**
   * Initialize a new recording session
   */
  async initializeSession(sessionId: string, userId: string): Promise<void> {
    this.buffers.set(sessionId, []);
    this.sessionStartTimes.set(sessionId, Date.now());
    this.totalSizes.set(sessionId, 0);

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
    await this.saveChunkToDisk(sessionId, audioData);

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

    const base64Audio = combinedBuffer.toString("base64");
    console.log(`[AudioProcessor] Processing chunk for ${sessionId}: ${totalSize} bytes (${bufferList.length} sub-chunks), base64 length: ${base64Audio.length}`);

    try {
      // Get previous transcript chunks for context continuity
      const session = await prisma.recordingSession.findUnique({
        where: { id: sessionId },
        include: { chunks: { orderBy: { chunkIndex: "asc" } } },
      });
      
      // Build previous context from recent chunks - only if they contain actual speech
      let previousContext = "";
      if (session && session.chunks.length > 0) {
        const recentChunks = session.chunks.slice(-3); // Last 3 chunks for context (reduced from 4)
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
          previousContext = contextTexts.join("\n\n");
        }
      }
      
      // Transcribe using Gemini with context
      const transcript = await transcribeAudio(base64Audio, mimeType, previousContext);

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
  private async saveChunkToDisk(sessionId: string, audioData: Buffer): Promise<void> {
    const audioDir = join(process.cwd(), "server", "audio", "sessions", sessionId);
    if (!existsSync(audioDir)) {
      await mkdir(audioDir, { recursive: true });
    }

    const timestamp = Date.now();
    const filePath = join(audioDir, `chunk-${timestamp}.webm`);
    await writeFile(filePath, audioData);
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
    // Clear all data
    this.buffers.delete(sessionId);
    const timer = this.chunkTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
    }
    this.chunkTimers.delete(sessionId);
    this.sessionStartTimes.delete(sessionId);
    this.totalSizes.delete(sessionId);

    // Clean up audio files
    await this.cleanupAudioFiles(sessionId);

    await prisma.recordingSession.update({
      where: { id: sessionId },
      data: { status: SessionStatus.CANCELLED },
    });
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
    } catch (error) {
      console.error(`[AudioProcessor] Error cleaning up audio files for ${sessionId}:`, error);
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

