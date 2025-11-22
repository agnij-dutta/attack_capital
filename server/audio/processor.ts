import { PrismaClient, SessionStatus } from "@prisma/client";
import { transcribeAudio, generateSummary } from "../lib/gemini";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();
const CHUNK_DURATION_MS = 30000; // 30 seconds
const MAX_BUFFER_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

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
    const currentSize = this.totalSizes.get(sessionId) || 0;
    const newSize = currentSize + audioData.length;

    // Check buffer overflow
    if (newSize > MAX_BUFFER_SIZE) {
      throw new Error("Buffer overflow: Session exceeds maximum size");
    }

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
   * Schedule chunk processing every 30 seconds
   */
  private scheduleChunkProcessing(sessionId: string, mimeType: string): void {
    const timer = setTimeout(async () => {
      await this.processChunk(sessionId, mimeType);
      this.chunkTimers.delete(sessionId);
      // Schedule next chunk if session still active
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
    if (!bufferList || bufferList.length === 0) return;

    // Combine buffers into single chunk
    const combinedBuffer = Buffer.concat(bufferList);
    const base64Audio = combinedBuffer.toString("base64");

    try {
      // Transcribe using Gemini
      const transcript = await transcribeAudio(base64Audio, mimeType);

      // Save transcript chunk to database
      const session = await prisma.recordingSession.findUnique({
        where: { id: sessionId },
        include: { chunks: true },
      });

      if (session) {
        await prisma.transcriptChunk.create({
          data: {
            sessionId,
            chunkIndex: session.chunks.length,
            text: transcript,
            timestamp: new Date(),
          },
        });
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

    // Clear timers
    const timer = this.chunkTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.chunkTimers.delete(sessionId);
    }

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

    // Combine all chunks into full transcript
    const fullTranscript = session.chunks.map((chunk) => chunk.text).join("\n\n");

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

    // Cleanup
    this.buffers.delete(sessionId);
    this.sessionStartTimes.delete(sessionId);
    this.totalSizes.delete(sessionId);

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

    await prisma.recordingSession.update({
      where: { id: sessionId },
      data: { status: SessionStatus.CANCELLED },
    });
  }
}

export const audioProcessor = new AudioProcessor();

