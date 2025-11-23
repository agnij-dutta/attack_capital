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
  const sessionIdRef = useRef<string | null>(null);

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
      if (sessionIdRef.current) {
        socket.emit("join-session", sessionIdRef.current);
        console.log(`Joined session room: ${sessionIdRef.current}`);
      }
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
      sessionIdRef.current = data.sessionId;
      // Join the session room to receive live updates
      socket.emit("join-session", data.sessionId);
      console.log(`Joined session room: ${data.sessionId}`);
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
          // Tab/screen share - must request video, but we'll only use audio track
          const displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: true, // Required by browser, even if we only use audio
            audio: true,
          });
          
          // Get only the audio track from the display stream
          const audioTracks = displayStream.getAudioTracks();
          if (audioTracks.length === 0) {
            throw new Error("No audio track available from screen share. Please ensure 'Share tab audio' is enabled.");
          }
          
          // Create a new stream with only the audio track
          stream = new MediaStream(audioTracks);
          
          // Stop video tracks to save resources (we don't need them)
          displayStream.getVideoTracks().forEach((track) => track.stop());
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

        // Initialize socket and start recording
        const socket = initializeSocket();
        const newSessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        setSessionId(newSessionId);
        sessionIdRef.current = newSessionId;

        // Join the session room immediately to receive live updates
        socket.emit("join-session", newSessionId);
        console.log(`Joined session room: ${newSessionId}`);

        // Handle data available event
        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);

            // Send chunk to server via WebSocket
            const reader = new FileReader();
            reader.onloadend = () => {
              const base64Audio = (reader.result as string).split(",")[1];
              const currentSessionId = sessionIdRef.current;
              if (socketRef.current?.connected && currentSessionId) {
                socketRef.current.emit("audio-chunk", {
                  sessionId: currentSessionId,
                  audioData: base64Audio,
                  mimeType,
                });
              }
            };
            reader.readAsDataURL(event.data);
          }
        };

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
    [userId, initializeSocket]
  );

  /**
   * Pause recording
   */
  const pauseRecording = useCallback(() => {
    if (mediaRecorderRef.current && state === "recording") {
      mediaRecorderRef.current.pause();
      const currentSessionId = sessionIdRef.current;
      if (socketRef.current && currentSessionId) {
        socketRef.current.emit("pause-recording", { sessionId: currentSessionId });
      }
    }
  }, [state]);

  /**
   * Resume recording
   */
  const resumeRecording = useCallback(() => {
    if (mediaRecorderRef.current && state === "paused") {
      mediaRecorderRef.current.resume();
      const currentSessionId = sessionIdRef.current;
      if (socketRef.current && currentSessionId) {
        socketRef.current.emit("resume-recording", { sessionId: currentSessionId });
      }
    }
  }, [state]);

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

    const currentSessionId = sessionIdRef.current;
    if (socketRef.current && currentSessionId) {
      socketRef.current.emit("stop-recording", { sessionId: currentSessionId });
    }
  }, []);

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

    const currentSessionId = sessionIdRef.current;
    if (socketRef.current && currentSessionId) {
      socketRef.current.emit("cancel-recording", { sessionId: currentSessionId });
    }

    setState("idle");
    setSessionId(null);
    sessionIdRef.current = null;
    audioChunksRef.current = [];
  }, []);

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

