"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Mic, Video, Play, Pause, Square, X, Loader2, History, LogOut, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { io, Socket } from "socket.io-client";
import { AIVoiceInput } from "@/components/ui/ai-voice-input";

export default function DashboardPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string>("");
  const [recordingMode, setRecordingMode] = useState<"mic" | "tab">("mic");
  const [sessionTime, setSessionTime] = useState<number>(0);
  const [liveTranscript, setLiveTranscript] = useState<string[]>([]);

  const {
    isRecording,
    isPaused,
    state,
    error,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    cancelRecording,
    sessionId,
  } = useAudioRecorder(userId);

  // Get user session
  useEffect(() => {
    async function getSession() {
      try {
        const response = await fetch("/api/auth/get-session");
        const data = await response.json();
        if (data.user?.id) {
          setUserId(data.user.id);
        } else {
          router.push("/sign-in");
        }
      } catch {
        router.push("/sign-in");
      }
    }
    getSession();
  }, [router]);

  // Session timer
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isRecording && !isPaused) {
      interval = setInterval(() => {
        setSessionTime((prev) => prev + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRecording, isPaused]);

  // Listen for live transcript updates with optimized socket connection
  useEffect(() => {
    if (!sessionId || !isRecording) {
      setLiveTranscript([]);
      return;
    }

    let socket: Socket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    const connectSocket = () => {
      socket = io("http://localhost:4000", {
        transports: ["websocket"],
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionAttempts: 10,
        timeout: 5000,
      });

      socket.on("connect", () => {
        console.log("[Dashboard] Socket connected for live transcription");
        // Join the session room to receive updates
        socket?.emit("join-session", sessionId);
        console.log(`[Dashboard] Joined session room: ${sessionId}`);
      });

      socket.on("live-transcript-update", (data: { sessionId: string; newChunk: { text: string; chunkIndex: number } }) => {
        console.log("[Dashboard] Received live transcript update:", data);
        if (data.sessionId === sessionId && data.newChunk?.text && data.newChunk.text.trim()) {
          const transcriptText = data.newChunk.text.trim();
          console.log("[Dashboard] Adding transcript chunk:", transcriptText);
          setLiveTranscript((prev) => {
            // Check if this chunk index already exists (avoid duplicates)
            const existingIndex = prev.findIndex((_, idx) => idx === data.newChunk.chunkIndex);
            if (existingIndex >= 0) {
              // Update existing chunk
              const updated = [...prev];
              updated[existingIndex] = transcriptText;
              return updated;
            } else {
              // Append new chunk
              return [...prev, transcriptText];
            }
          });
        } else {
          console.warn("[Dashboard] Transcript update rejected:", {
            sessionMatch: data.sessionId === sessionId,
            hasText: !!data.newChunk?.text?.trim(),
            sessionId,
            receivedSessionId: data.sessionId,
          });
        }
      });

      socket.on("disconnect", () => {
        console.log("[Dashboard] Socket disconnected, will reconnect...");
      });

      socket.on("connect_error", (error) => {
        console.error("[Dashboard] Socket connection error:", error);
      });
    };

    connectSocket();

    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (socket) {
        socket.disconnect();
        socket = null;
      }
    };
  }, [sessionId, isRecording]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const handleStop = async () => {
    await stopRecording();
    toast.success("Recording stopped. Processing transcript...");
    if (sessionId) {
      setTimeout(() => {
        router.push(`/sessions/${sessionId}`);
      }, 1000);
    }
  };

  const handleSignOut = async () => {
    await fetch("/api/auth/sign-out", { method: "POST" });
    toast.success("Signed out successfully");
    router.push("/sign-in");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
      <Toaster />
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold tracking-tight">Dashboard</h1>
            <p className="mt-2 text-muted-foreground">
              Start recording your meetings and get AI-powered transcripts
            </p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/sessions">
                <History className="mr-2 h-4 w-4" />
                Sessions
              </Link>
            </Button>
            <Button variant="outline" onClick={handleSignOut}>
              <LogOut className="mr-2 h-4 w-4" />
              Sign Out
            </Button>
          </div>
        </div>

        <div className="mx-auto max-w-4xl space-y-6">
          {/* Recording Controls */}
          <Card>
            <CardHeader>
              <CardTitle>Recording Studio</CardTitle>
              <CardDescription>
                Choose your audio source and start recording
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {state === "idle" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <Button
                      variant={recordingMode === "mic" ? "default" : "outline"}
                      size="lg"
                      className="h-24 flex-col gap-2"
                      onClick={() => setRecordingMode("mic")}
                    >
                      <Mic className="h-6 w-6" />
                      <span>Microphone</span>
                    </Button>
                    <Button
                      variant={recordingMode === "tab" ? "default" : "outline"}
                      size="lg"
                      className="h-24 flex-col gap-2"
                      onClick={() => setRecordingMode("tab")}
                    >
                      <Video className="h-6 w-6" />
                      <span>Tab/Share</span>
                    </Button>
                  </div>
                  <Button
                    onClick={() => startRecording(recordingMode)}
                    size="lg"
                    className="w-full"
                  >
                    <Play className="mr-2 h-5 w-5" />
                    Start Recording
                  </Button>
                </div>
              )}

              {state === "recording" && (
                <div className="space-y-6">
                  {/* Mic Animation - Now includes timer and is bigger */}
                  <AIVoiceInput
                    onStart={() => {}}
                    onStop={() => {}}
                    visualizerBars={64}
                    demoMode={false}
                    isRecording={true}
                    externalTime={sessionTime}
                    className="bg-transparent"
                  />
                  
                  <Separator />
                  
                  {/* Live Transcript Display - Always show when recording */}
                  <Card className="bg-muted/50">
                    <CardHeader>
                      <CardTitle className="text-sm flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                        Live Transcription
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="max-h-64 overflow-y-auto space-y-2 text-sm min-h-[100px]">
                        {liveTranscript.length > 0 ? (
                          <div className="space-y-2">
                            {liveTranscript.map((chunk, idx) => (
                              <p key={idx} className="text-foreground animate-in fade-in duration-300">
                                {chunk}
                              </p>
                            ))}
                          </div>
                        ) : (
                          <p className="text-muted-foreground italic">
                            Listening... Transcription will appear here as audio is processed (every 8 seconds)
                          </p>
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  <div className="grid grid-cols-3 gap-3">
                    <Button
                      onClick={pauseRecording}
                      variant="outline"
                      size="lg"
                      className="gap-2"
                    >
                      <Pause className="h-4 w-4" />
                      Pause
                    </Button>
                    <Button
                      onClick={handleStop}
                      variant="destructive"
                      size="lg"
                      className="gap-2"
                    >
                      <Square className="h-4 w-4" />
                      Stop
                    </Button>
                    <Button
                      onClick={cancelRecording}
                      variant="outline"
                      size="lg"
                      className="gap-2"
                    >
                      <X className="h-4 w-4" />
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {state === "paused" && (
                <div className="space-y-6">
                  <div className="text-center space-y-2">
                    <div className="text-6xl font-bold text-muted-foreground">
                      {formatTime(sessionTime)}
                    </div>
                    <Badge variant="secondary">Paused</Badge>
                  </div>
                  <Separator />
                  <div className="grid grid-cols-3 gap-3">
                    <Button
                      onClick={resumeRecording}
                      size="lg"
                      className="gap-2"
                    >
                      <Play className="h-4 w-4" />
                      Resume
                    </Button>
                    <Button
                      onClick={handleStop}
                      variant="destructive"
                      size="lg"
                      className="gap-2"
                    >
                      <Square className="h-4 w-4" />
                      Stop
                    </Button>
                    <Button
                      onClick={cancelRecording}
                      variant="outline"
                      size="lg"
                      className="gap-2"
                    >
                      <X className="h-4 w-4" />
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {state === "processing" && (
                <div className="flex flex-col items-center justify-center py-12 space-y-4">
                  <Loader2 className="h-12 w-12 animate-spin text-primary" />
                  <div className="text-center space-y-2">
                    <p className="text-lg font-semibold">Processing transcript...</p>
                    <p className="text-sm text-muted-foreground">
                      Generating AI summary
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
