"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { io, Socket } from "socket.io-client";

type RecordingMode = "mic" | "tab";

type RecordingState = "idle" | "recording" | "paused" | "processing" | "completed";

interface UseAudioRecorderReturn {
  isRecording: boolean;
  isPaused: boolean;
  state: RecordingState;
  error: string | null;
  startRecording: (mode: RecordingMode) => Promise<void>;
  pauseRecording: () => void;
  resumeRecording: () => void;
  stopRecording: () => Promise<void>;
  cancelRecording: () => void;
  sessionId: string | null;
}

/**
 * Custom hook for audio recording with WebSocket streaming
 * Supports both microphone and tab/screen share audio capture
 */
export function useAudioRecorder(
  userId: string,
  websocketUrl: string = "http://localhost:4000"
): UseAudioRecorderReturn {
  const [state, setState] = useState<RecordingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  /**
   * Initialize WebSocket connection
   */
  const initializeSocket = useCallback(() => {
    if (socketRef.current?.connected) return socketRef.current;

    const socket = io(websocketUrl, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
    });

    socket.on("connect", () => {
      console.log("WebSocket connected");
    });

    socket.on("disconnect", () => {
      console.log("WebSocket disconnected");
      if (state === "recording") {
        setError("Connection lost. Attempting to reconnect...");
      }
    });

    socket.on("error", (data: { message: string }) => {
      setError(data.message);
    });

    socket.on("recording-started", (data: { sessionId: string }) => {
      setSessionId(data.sessionId);
      setState("recording");
    });

    socket.on("recording-paused", () => {
      setState("paused");
    });

    socket.on("recording-resumed", () => {
      setState("recording");
    });

    socket.on("status-update", (data: { status: string }) => {
      if (data.status === "processing") {
        setState("processing");
      } else if (data.status === "completed") {
        setState("completed");
      }
    });

    socket.on("recording-completed", () => {
      setState("completed");
    });

    socket.on("ping", () => {
      socket.emit("pong");
    });

    socketRef.current = socket;
    return socket;
  }, [websocketUrl, state]);

  /**
   * Start recording with specified mode
   */
  const startRecording = useCallback(
    async (mode: RecordingMode) => {
      try {
        setError(null);
        setState("idle");

        // Get media stream based on mode
        let stream: MediaStream;
        if (mode === "mic") {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              sampleRate: 44100,
            },
          });
        } else {
          // Tab/screen share
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: false,
            audio: true,
          });
        }

        streamRef.current = stream;

        // Initialize MediaRecorder
        const mimeType = MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/mp4";
        const mediaRecorder = new MediaRecorder(stream, {
          mimeType,
          audioBitsPerSecond: 128000,
        });

        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];

        // Handle data available event
        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);

            // Send chunk to server via WebSocket
            const reader = new FileReader();
            reader.onloadend = () => {
              const base64Audio = (reader.result as string).split(",")[1];
              if (socketRef.current?.connected) {
                socketRef.current.emit("audio-chunk", {
                  sessionId,
                  audioData: base64Audio,
                  mimeType,
                });
              }
            };
            reader.readAsDataURL(event.data);
          }
        };

        // Initialize socket and start recording
        const socket = initializeSocket();
        const newSessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        setSessionId(newSessionId);

        // Start MediaRecorder (send chunks every 1 second)
        mediaRecorder.start(1000);

        // Notify server
        socket.emit("start-recording", {
          sessionId: newSessionId,
          userId,
          mimeType,
        });
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to start recording";
        setError(errorMessage);
        setState("idle");

        // Cleanup on error
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
      }
    },
    [userId, initializeSocket, sessionId]
  );

  /**
   * Pause recording
   */
  const pauseRecording = useCallback(() => {
    if (mediaRecorderRef.current && state === "recording") {
      mediaRecorderRef.current.pause();
      if (socketRef.current && sessionId) {
        socketRef.current.emit("pause-recording", { sessionId });
      }
    }
  }, [state, sessionId]);

  /**
   * Resume recording
   */
  const resumeRecording = useCallback(() => {
    if (mediaRecorderRef.current && state === "paused") {
      mediaRecorderRef.current.resume();
      if (socketRef.current && sessionId) {
        socketRef.current.emit("resume-recording", { sessionId });
      }
    }
  }, [state, sessionId]);

  /**
   * Stop recording
   */
  const stopRecording = useCallback(async () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (socketRef.current && sessionId) {
      socketRef.current.emit("stop-recording", { sessionId });
    }
  }, [sessionId]);

  /**
   * Cancel recording
   */
  const cancelRecording = useCallback(() => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (socketRef.current && sessionId) {
      socketRef.current.emit("cancel-recording", { sessionId });
    }

    setState("idle");
    setSessionId(null);
    audioChunksRef.current = [];
  }, [sessionId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (mediaRecorderRef.current) {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  return {
    isRecording: state === "recording",
    isPaused: state === "paused",
    state,
    error,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    cancelRecording,
    sessionId,
  };
}

