import { Socket, Server } from "socket.io";
import { audioProcessor } from "../audio/processor";
import { z } from "zod";

const StartRecordingSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  mimeType: z.string().optional().default("audio/webm"),
});

const AudioChunkSchema = z.object({
  sessionId: z.string(),
  audioData: z.string(), // Base64 encoded
  mimeType: z.string().optional().default("audio/webm"),
});

const SessionActionSchema = z.object({
  sessionId: z.string(),
});

/**
 * Setup Socket.io event handlers for audio streaming
 */
export function setupSocketHandlers(socket: Socket, io: Server): void {
  // Heartbeat mechanism
  const heartbeatInterval = setInterval(() => {
    socket.emit("ping");
  }, 10000); // Every 10 seconds

  socket.on("pong", () => {
    // Client responded to ping
  });

  /**
   * Join a session room to receive live transcript updates
   */
  socket.on("join-session", (sessionId: string) => {
    if (sessionId) {
      socket.join(sessionId);
      console.log(`Client ${socket.id} joined session room: ${sessionId}`);
    }
  });

  /**
   * Start a new recording session
   */
  socket.on("start-recording", async (data: unknown) => {
    try {
      const { sessionId, userId, mimeType } = StartRecordingSchema.parse(data);
      await audioProcessor.initializeSession(sessionId, userId);
      socket.emit("recording-started", { sessionId });
      socket.broadcast.emit("status-update", {
        sessionId,
        status: "recording",
      });
    } catch (error) {
      console.error("Error starting recording:", error);
      socket.emit("error", { message: "Failed to start recording" });
    }
  });

  /**
   * Receive audio chunk from client
   */
  socket.on("audio-chunk", async (data: unknown) => {
    try {
      const { sessionId, audioData, mimeType } = AudioChunkSchema.parse(data);
      const buffer = Buffer.from(audioData, "base64");
      await audioProcessor.addChunk(sessionId, buffer, mimeType);

      // Emit acknowledgment
      socket.emit("chunk-received", { sessionId });
    } catch (error) {
      console.error("Error processing audio chunk:", error);
      socket.emit("error", { message: "Failed to process audio chunk" });
    }
  });

  /**
   * Pause recording
   */
  socket.on("pause-recording", async (data: unknown) => {
    try {
      const { sessionId } = SessionActionSchema.parse(data);
      await audioProcessor.pauseRecording(sessionId);
      socket.emit("recording-paused", { sessionId });
      socket.broadcast.emit("status-update", {
        sessionId,
        status: "paused",
      });
    } catch (error) {
      console.error("Error pausing recording:", error);
      socket.emit("error", { message: "Failed to pause recording" });
    }
  });

  /**
   * Resume recording
   */
  socket.on("resume-recording", async (data: unknown) => {
    try {
      const { sessionId, mimeType } = SessionActionSchema.extend({
        mimeType: z.string().optional(),
      }).parse(data);
      await audioProcessor.resumeRecording(sessionId, mimeType);
      socket.emit("recording-resumed", { sessionId });
      socket.broadcast.emit("status-update", {
        sessionId,
        status: "recording",
      });
    } catch (error) {
      console.error("Error resuming recording:", error);
      socket.emit("error", { message: "Failed to resume recording" });
    }
  });

  /**
   * Stop recording and generate summary
   */
  socket.on("stop-recording", async (data: unknown) => {
    try {
      const { sessionId } = SessionActionSchema.parse(data);
      socket.emit("status-update", {
        sessionId,
        status: "processing",
      });

      const { transcript, summary } = await audioProcessor.stopRecording(sessionId);

      socket.emit("recording-completed", {
        sessionId,
        transcript,
        summary,
      });

      socket.broadcast.emit("status-update", {
        sessionId,
        status: "completed",
      });
    } catch (error) {
      console.error("Error stopping recording:", error);
      socket.emit("error", { message: "Failed to stop recording" });
    }
  });

  /**
   * Cancel recording
   */
  socket.on("cancel-recording", async (data: unknown) => {
    try {
      const { sessionId } = SessionActionSchema.parse(data);
      await audioProcessor.cancelRecording(sessionId);
      socket.emit("recording-cancelled", { sessionId });
      socket.broadcast.emit("status-update", {
        sessionId,
        status: "cancelled",
      });
    } catch (error) {
      console.error("Error cancelling recording:", error);
      socket.emit("error", { message: "Failed to cancel recording" });
    }
  });

  /**
   * Handle disconnection
   */
  socket.on("disconnect", () => {
    clearInterval(heartbeatInterval);
    console.log(`Client disconnected: ${socket.id}`);
  });
}

