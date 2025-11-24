"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { io, Socket } from "socket.io-client";
import {
  queueChunk,
  getQueuedChunks,
  removeChunk,
  incrementRetryCount,
  clearSessionQueue,
} from "@/lib/audioQueue";

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

    socket.on("connect", async () => {
      console.log("WebSocket connected");
      if (sessionIdRef.current) {
        socket.emit("join-session", sessionIdRef.current);
        console.log(`Joined session room: ${sessionIdRef.current}`);
        
        // Process any queued chunks when reconnected
        await processQueuedChunks(sessionIdRef.current, socket);
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
   * Process queued chunks when connection is restored
   */
  const processQueuedChunks = useCallback(async (sessionId: string, socket: Socket) => {
    try {
      const queuedChunks = await getQueuedChunks(sessionId);
      if (queuedChunks.length === 0) {
        return;
      }

      console.log(`[AudioRecorder] Processing ${queuedChunks.length} queued chunks for session ${sessionId}`);

      // Sort by timestamp to maintain order
      queuedChunks.sort((a, b) => a.timestamp - b.timestamp);

      // Process chunks with rate limiting (one every 100ms to avoid overwhelming)
      for (const chunk of queuedChunks) {
        if (chunk.retryCount >= 5) {
          console.warn(`[AudioRecorder] Chunk ${chunk.id} exceeded max retries, removing`);
          await removeChunk(chunk.id);
          continue;
        }

        try {
          socket.emit("audio-chunk", {
            sessionId: chunk.sessionId,
            audioData: chunk.audioData,
            mimeType: chunk.mimeType,
          });

          // Wait for acknowledgment
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(async () => {
              // No ack received, increment retry count
              await incrementRetryCount(chunk.id);
              resolve();
            }, 2000);

            socket.once("chunk-received", async () => {
              clearTimeout(timeout);
              await removeChunk(chunk.id);
              resolve();
            });
          });

          // Small delay between chunks
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error) {
          console.error(`[AudioRecorder] Error processing queued chunk ${chunk.id}:`, error);
          await incrementRetryCount(chunk.id);
        }
      }

      console.log(`[AudioRecorder] Finished processing queued chunks for session ${sessionId}`);
    } catch (error) {
      console.error("[AudioRecorder] Error processing queued chunks:", error);
    }
  }, []);

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
              autoGainControl: true,
              sampleRate: 48000, // Higher sample rate for better quality (CD quality is 44.1kHz, professional is 48kHz)
              channelCount: 1, // Mono is fine for speech, but ensure consistent quality
            },
          });
          
          // Verify audio track is actually capturing
          const audioTracks = stream.getAudioTracks();
          if (audioTracks.length === 0) {
            throw new Error("No audio tracks available from microphone");
          }
          
          const activeTrack = audioTracks[0];
          console.log(`[AudioRecorder] Microphone track:`, {
            label: activeTrack.label,
            enabled: activeTrack.enabled,
            readyState: activeTrack.readyState,
            muted: activeTrack.muted,
            settings: activeTrack.getSettings(),
          });
          
          // Set up audio level monitoring to verify audio is being captured
          const audioContext = new AudioContext();
          const source = audioContext.createMediaStreamSource(stream);
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          
          // Check audio levels after a short delay
          setTimeout(() => {
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(dataArray);
            const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
            console.log(`[AudioRecorder] Audio level check: average=${average.toFixed(2)}`);
            if (average < 1) {
              console.warn(`[AudioRecorder] Very low audio levels detected - microphone may not be capturing audio properly`);
            }
            audioContext.close();
          }, 1000);
        } else {
          // Tab/screen share - captures ALL audio from the shared tab
          // IMPORTANT: When "Share tab audio" is enabled in Google Meet, this captures:
          // - All participants' audio (mixed together by Google Meet)
          // - The person sharing's audio (also mixed in)
          // - Any system sounds from that tab
          // This is the mixed audio output from the tab, so all meeting participants are included
          const displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              displaySurface: "browser", // Prefer browser tab sharing for better audio capture
            } as MediaTrackConstraints,
            audio: {
              echoCancellation: false, // Disable - we want the raw mixed audio from the tab
              noiseSuppression: false, // Disable - we want all audio including all participants
              autoGainControl: false, // Disable - preserve original audio levels from meeting
              sampleRate: 48000, // Higher sample rate for better quality (professional audio)
              channelCount: 2, // Stereo if available - captures full audio spectrum
            },
          });
          
          // Wait longer for audio tracks to be available (Google Meet may need more time)
          // Also check if audio tracks become available during the wait
          let audioTracksAvailable = false;
          for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 200));
            const tracks = displayStream.getAudioTracks();
            if (tracks.length > 0 && tracks.some(t => t.readyState === "live")) {
              audioTracksAvailable = true;
              break;
            }
          }
          
          if (!audioTracksAvailable) {
            console.warn("[AudioRecorder] Audio tracks not available after waiting - Google Meet may need more time to initialize audio");
          }
          
          // Get only the audio track from the display stream
          const audioTracks = displayStream.getAudioTracks();
          if (audioTracks.length === 0) {
            // Stop video tracks before throwing error
            displayStream.getVideoTracks().forEach((track) => track.stop());
            throw new Error("No audio track available from screen share. Please ensure 'Share tab audio' is enabled in your browser's share dialog when sharing the Google Meet tab.");
          }
          
          // Verify audio track is actually active
          const activeAudioTrack = audioTracks.find(track => track.readyState === "live" && track.enabled);
          if (!activeAudioTrack) {
            displayStream.getVideoTracks().forEach((track) => track.stop());
            throw new Error("Audio track is not active. Please ensure 'Share tab audio' is checked when sharing.");
          }
          
          const trackSettings = activeAudioTrack.getSettings();
          console.log(`[AudioRecorder] Tab audio track captured:`, {
            label: activeAudioTrack.label,
            enabled: activeAudioTrack.enabled,
            readyState: activeAudioTrack.readyState,
            muted: activeAudioTrack.muted,
            sampleRate: trackSettings.sampleRate,
            channelCount: trackSettings.channelCount,
            echoCancellation: trackSettings.echoCancellation,
            noiseSuppression: trackSettings.noiseSuppression,
            autoGainControl: trackSettings.autoGainControl,
          });
          
          // Log important info about what audio is being captured
          console.log(`[AudioRecorder] ✅ Tab audio capture active - This will capture ALL audio from the shared tab, including:`);
          console.log(`[AudioRecorder]   - All meeting participants' voices (mixed by Google Meet)`);
          console.log(`[AudioRecorder]   - The person sharing's voice (also in the mix)`);
          console.log(`[AudioRecorder]   - Any system sounds from that tab`);
          
          // Create a new stream with only the audio track
          // This audio track contains the MIXED audio from the tab, which includes:
          // - All meeting participants' voices (mixed by Google Meet)
          // - The person sharing's voice (also in the mix)
          // - System sounds from that tab
          stream = new MediaStream([activeAudioTrack]);
          
          // Set up continuous audio level monitoring for tab audio
          // This helps verify that we're actually capturing audio from the meeting
          const audioContext = new AudioContext({ sampleRate: 48000 });
          const source = audioContext.createMediaStreamSource(stream);
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 512; // Larger FFT for better frequency analysis
          analyser.smoothingTimeConstant = 0.8;
          source.connect(analyser);
          
          // Verify we have a valid audio stream
          console.log(`[AudioRecorder] ✅ Tab audio stream created successfully`);
          console.log(`[AudioRecorder]   Stream contains ${stream.getAudioTracks().length} audio track(s)`);
          console.log(`[AudioRecorder]   This will transcribe ALL participants in the meeting`);
          
          // Monitor audio levels continuously
          let audioLevelCheckCount = 0;
          const checkAudioLevels = () => {
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(dataArray);
            const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
            const max = Math.max(...Array.from(dataArray));
            
            if (audioLevelCheckCount < 5) {
              console.log(`[AudioRecorder] Tab audio level check ${audioLevelCheckCount + 1}: average=${average.toFixed(2)}, max=${max}`);
              audioLevelCheckCount++;
              
              if (average < 0.5 && max < 5) {
                console.warn(`[AudioRecorder] ⚠️ Very low audio levels from tab - audio may not be captured properly.`);
                console.warn(`[AudioRecorder]   - Ensure Google Meet audio is playing (unmute speakers/headphones)`);
                console.warn(`[AudioRecorder]   - Ensure participants are speaking or audio is playing in the meeting`);
                console.warn(`[AudioRecorder]   - Check that "Share tab audio" was enabled when sharing`);
              } else {
                console.log(`[AudioRecorder] ✅ Audio levels normal - capturing meeting audio successfully`);
              }
              
              if (audioLevelCheckCount < 5) {
                setTimeout(checkAudioLevels, 2000);
              } else {
                audioContext.close();
              }
            }
          };
          
          // Start checking after a delay
          setTimeout(checkAudioLevels, 2000);
          
          // Stop video tracks to save resources (we don't need them)
          displayStream.getVideoTracks().forEach((track) => track.stop());
          
          // Monitor audio track for disconnection
          activeAudioTrack.onended = () => {
            console.warn("[AudioRecorder] Audio track ended - user may have stopped sharing");
            setError("Audio sharing was stopped. Please restart the recording.");
            audioContext.close();
          };
        }

        streamRef.current = stream;

        // Verify audio tracks are active
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
          throw new Error("No audio tracks available in stream");
        }

        const activeTrack = audioTracks.find(track => track.readyState === "live" && track.enabled);
        if (!activeTrack) {
          throw new Error("Audio track is not active or enabled");
        }

        console.log(`[AudioRecorder] Audio track state:`, {
          label: activeTrack.label,
          enabled: activeTrack.enabled,
          readyState: activeTrack.readyState,
          muted: activeTrack.muted,
          settings: activeTrack.getSettings(),
        });

        // Initialize MediaRecorder with optimal settings for quality
        // For tab audio (Google Meet), use higher bitrate for better quality
        const isTabAudio = mode === "tab";
        // Try to use OGG format first (supported by Gemini), fallback to WebM if not available
        // Gemini supports: WAV, MP3, AIFF, AAC, OGG Vorbis, FLAC
        // WebM is NOT supported, so we prefer OGG (will be converted on server if WebM)
        const mimeType = MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
          ? "audio/ogg;codecs=opus" // Preferred - supported by Gemini
          : MediaRecorder.isTypeSupported("audio/ogg")
          ? "audio/ogg" // Supported by Gemini
          : MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus" // Will be converted to MP3 on server
          : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm" // Will be converted to MP3 on server
          : "audio/webm"; // Default fallback (will be converted)
        
        // Higher bitrate for better quality transcription accuracy
        // Opus codec supports up to 510kbps, but 256kbps is excellent for speech
        // For tab audio (meetings), use higher bitrate to preserve all audio details
        const audioBitsPerSecond = isTabAudio ? 256000 : 192000; // Increased from 192k/128k
        
        // Additional MediaRecorder options for better quality
        const mediaRecorderOptions: MediaRecorderOptions = {
          mimeType,
          audioBitsPerSecond,
        };
        
        // Try to set videoBitsPerSecond if supported (some browsers use this for audio quality)
        const mediaRecorder = new MediaRecorder(stream, mediaRecorderOptions);
        
        console.log(`[AudioRecorder] MediaRecorder initialized: mimeType=${mimeType}, bitrate=${audioBitsPerSecond}, mode=${mode}`);

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
          if (event.data && event.data.size > 0) {
            // Only send chunks that are substantial (at least 1KB to avoid empty/silent chunks)
            if (event.data.size < 1024) {
              console.warn(`[AudioRecorder] Skipping small chunk: ${event.data.size} bytes`);
              return;
            }

            audioChunksRef.current.push(event.data);

            // Send chunk to server via WebSocket, with queue fallback
            const reader = new FileReader();
            reader.onloadend = async () => {
              const base64Audio = (reader.result as string).split(",")[1];
              const currentSessionId = sessionIdRef.current;
              
              if (!currentSessionId || !base64Audio) {
                console.warn("[AudioRecorder] Missing sessionId or audio data");
                return;
              }

              // Try to send immediately if connected
              if (socketRef.current?.connected) {
                try {
                  console.log(`[AudioRecorder] Sending audio chunk: ${event.data.size} bytes, base64 length: ${base64Audio.length}`);
                  socketRef.current.emit("audio-chunk", {
                    sessionId: currentSessionId,
                    audioData: base64Audio,
                    mimeType,
                  });
                  
                  // Wait for acknowledgment (chunk-received event)
                  // If no ack within 2s, queue it
                  const ackTimeout = setTimeout(async () => {
                    console.warn("[AudioRecorder] No acknowledgment received, queueing chunk");
                    await queueChunk(currentSessionId, base64Audio, mimeType);
                  }, 2000);
                  
                  // Remove timeout on ack (handled in socket listener)
                  socketRef.current.once("chunk-received", () => {
                    clearTimeout(ackTimeout);
                  });
                } catch (error) {
                  console.error("[AudioRecorder] Error sending chunk, queueing:", error);
                  await queueChunk(currentSessionId, base64Audio, mimeType);
                }
              } else {
                // Not connected - queue the chunk
                console.log("[AudioRecorder] Not connected, queueing chunk for later");
                await queueChunk(currentSessionId, base64Audio, mimeType);
              }
            };
            reader.onerror = (error) => {
              console.error("[AudioRecorder] Error reading audio chunk:", error);
            };
            reader.readAsDataURL(event.data);
          } else {
            console.warn(`[AudioRecorder] Received empty or invalid chunk: size=${event.data?.size || 0}`);
          }
        };

        mediaRecorder.onerror = (event) => {
          console.error("[AudioRecorder] MediaRecorder error:", event);
          setError("Recording error occurred");
        };

        // Start MediaRecorder with optimal chunk interval for quality and real-time transcription
        // 1.5 seconds provides good balance: frequent enough for real-time, large enough for quality
        const chunkInterval = 1500; // 1.5 seconds
        mediaRecorder.start(chunkInterval);
        console.log(`[AudioRecorder] Started recording with ${chunkInterval}ms chunk interval, bitrate: ${audioBitsPerSecond}bps`);
        console.log(`[AudioRecorder] Started recording with mimeType: ${mimeType}`);

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
    
    // Process any remaining queued chunks before stopping
    if (socketRef.current?.connected && currentSessionId) {
      await processQueuedChunks(currentSessionId, socketRef.current);
    }
    
    if (socketRef.current && currentSessionId) {
      socketRef.current.emit("stop-recording", { sessionId: currentSessionId });
    }
    
    // Clear queue after a delay (in case there are still pending chunks)
    if (currentSessionId) {
      setTimeout(async () => {
        await clearSessionQueue(currentSessionId);
      }, 5000);
    }
  }, [processQueuedChunks]);

  /**
   * Cancel recording
   */
  const cancelRecording = useCallback(async () => {
    console.log("[AudioRecorder] Cancelling recording...");
    
    // Stop media recorder
    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
        mediaRecorderRef.current.stream.getTracks().forEach((track) => {
          track.stop();
          track.enabled = false;
        });
      } catch (error) {
        console.error("[AudioRecorder] Error stopping media recorder:", error);
      }
      mediaRecorderRef.current = null;
    }

    // Stop all stream tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        track.stop();
        track.enabled = false;
      });
      streamRef.current = null;
    }

    const currentSessionId = sessionIdRef.current;
    
    // Notify server to cancel
    if (socketRef.current && currentSessionId) {
      try {
        socketRef.current.emit("cancel-recording", { sessionId: currentSessionId });
        console.log(`[AudioRecorder] Sent cancel-recording for session ${currentSessionId}`);
      } catch (error) {
        console.error("[AudioRecorder] Error sending cancel-recording:", error);
      }
    }

    // Clear queued chunks for this session
    if (currentSessionId) {
      try {
        await clearSessionQueue(currentSessionId);
        console.log(`[AudioRecorder] Cleared queue for session ${currentSessionId}`);
      } catch (error) {
        console.error("[AudioRecorder] Error clearing queue:", error);
      }
    }

    // Reset all state
    setState("idle");
    setSessionId(null);
    sessionIdRef.current = null;
    audioChunksRef.current = [];
    setError(null);
    
    console.log("[AudioRecorder] Recording cancelled and state reset");
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

