"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import Link from "next/link";

export default function DashboardPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string>("");
  const [recordingMode, setRecordingMode] = useState<"mic" | "tab">("mic");
  const [transcript, setTranscript] = useState<string>("");
  const [sessionTime, setSessionTime] = useState<number>(0);

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

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const handleStop = async () => {
    await stopRecording();
    if (sessionId) {
      router.push(`/sessions/${sessionId}`);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
          <div className="flex gap-4">
            <Link
              href="/sessions"
              className="rounded-lg bg-white px-4 py-2 text-gray-700 shadow-sm transition-colors hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Sessions
            </Link>
            <button
              onClick={async () => {
                await fetch("/api/auth/sign-out", { method: "POST" });
                router.push("/sign-in");
              }}
              className="rounded-lg bg-white px-4 py-2 text-gray-700 shadow-sm transition-colors hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Sign Out
            </button>
          </div>
        </div>

        <div className="mx-auto max-w-4xl space-y-6">
          {/* Recording Controls */}
          <div className="rounded-2xl bg-white p-8 shadow-xl dark:bg-gray-800">
            <h2 className="mb-6 text-2xl font-semibold text-gray-900 dark:text-white">
              Start Recording
            </h2>

            {error && (
              <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                {error}
              </div>
            )}

            {state === "idle" && (
              <div className="space-y-4">
                <div className="flex gap-4">
                  <button
                    onClick={() => setRecordingMode("mic")}
                    className={`flex-1 rounded-lg border-2 px-4 py-3 font-medium transition-colors ${
                      recordingMode === "mic"
                        ? "border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-400"
                        : "border-gray-300 bg-white text-gray-700 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
                    }`}
                  >
                    Microphone
                  </button>
                  <button
                    onClick={() => setRecordingMode("tab")}
                    className={`flex-1 rounded-lg border-2 px-4 py-3 font-medium transition-colors ${
                      recordingMode === "tab"
                        ? "border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-400"
                        : "border-gray-300 bg-white text-gray-700 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
                    }`}
                  >
                    Tab/Share
                  </button>
                </div>
                <button
                  onClick={() => startRecording(recordingMode)}
                  className="w-full rounded-lg bg-indigo-600 px-6 py-4 text-lg font-medium text-white transition-colors hover:bg-indigo-700"
                >
                  Start Recording
                </button>
              </div>
            )}

            {state === "recording" && (
              <div className="space-y-4">
                <div className="text-center">
                  <div className="mb-2 text-4xl font-bold text-indigo-600 dark:text-indigo-400">
                    {formatTime(sessionTime)}
                  </div>
                  <div className="flex items-center justify-center gap-2 text-red-600 dark:text-red-400">
                    <div className="h-3 w-3 animate-pulse rounded-full bg-red-600"></div>
                    <span className="font-medium">Recording</span>
                  </div>
                </div>
                <div className="flex gap-4">
                  <button
                    onClick={pauseRecording}
                    className="flex-1 rounded-lg bg-yellow-500 px-4 py-3 font-medium text-white transition-colors hover:bg-yellow-600"
                  >
                    Pause
                  </button>
                  <button
                    onClick={handleStop}
                    className="flex-1 rounded-lg bg-red-600 px-4 py-3 font-medium text-white transition-colors hover:bg-red-700"
                  >
                    Stop
                  </button>
                  <button
                    onClick={cancelRecording}
                    className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-3 font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {state === "paused" && (
              <div className="space-y-4">
                <div className="text-center">
                  <div className="mb-2 text-4xl font-bold text-gray-600 dark:text-gray-400">
                    {formatTime(sessionTime)}
                  </div>
                  <div className="text-yellow-600 dark:text-yellow-400">Paused</div>
                </div>
                <div className="flex gap-4">
                  <button
                    onClick={resumeRecording}
                    className="flex-1 rounded-lg bg-indigo-600 px-4 py-3 font-medium text-white transition-colors hover:bg-indigo-700"
                  >
                    Resume
                  </button>
                  <button
                    onClick={handleStop}
                    className="flex-1 rounded-lg bg-red-600 px-4 py-3 font-medium text-white transition-colors hover:bg-red-700"
                  >
                    Stop
                  </button>
                  <button
                    onClick={cancelRecording}
                    className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-3 font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {state === "processing" && (
              <div className="text-center">
                <div className="mb-4 text-lg font-medium text-gray-700 dark:text-gray-300">
                  Processing transcript...
                </div>
                <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent"></div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

