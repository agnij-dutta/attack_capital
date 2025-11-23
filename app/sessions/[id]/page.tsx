"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import LoadingLines from "@/components/ui/loading-lines";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface Session {
  id: string;
  title: string | null;
  status: string;
  transcriptText: string | null;
  summary: string | null;
  duration: number | null;
  createdAt: string;
  chunks: Array<{
    id: string;
    chunkIndex: number;
    text: string;
    timestamp: string;
  }>;
}

export default function SessionDetailPage() {
  const router = useRouter();
  const params = useParams();
  const sessionId = params.id as string;
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState("Initializing...");

  useEffect(() => {
    let isMounted = true;
    
    async function fetchSession() {
      try {
        setLoading(true);
        const response = await fetch(`/api/sessions/${sessionId}`);
        
        if (!isMounted) return;
        
        if (response.status === 401) {
          router.push("/sign-in");
          setLoading(false);
          return;
        }
        if (response.status === 404) {
          router.push("/sessions");
          setLoading(false);
          return;
        }
        
        if (!response.ok) {
          throw new Error(`Failed to fetch session: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (!isMounted) return;
        
        if (data.session) {
          setSession(data.session);
          // Keep loading state if session is still processing or recording
          if (data.session.status === "PROCESSING" || data.session.status === "RECORDING") {
            setLoading(true); // Keep loading state
          } else {
            setLoading(false);
          }
        } else {
          console.error("No session data in response:", data);
          router.push("/sessions");
          setLoading(false);
        }
      } catch (error) {
        console.error("Error fetching session:", error);
        if (isMounted) {
          toast.error("Failed to load session. Redirecting...");
          setTimeout(() => router.push("/sessions"), 2000);
          setLoading(false);
        }
      }
    }
    
    if (sessionId) {
      fetchSession();
    } else {
      setLoading(false);
    }
    
    return () => {
      isMounted = false;
    };
  }, [sessionId, router]);

  // Poll for updates when session is processing or recording - keep loading state until COMPLETED
  useEffect(() => {
    if (!session || (session.status !== "PROCESSING" && session.status !== "RECORDING")) {
      // If session is not processing or recording, ensure loading is false
      if (session && session.status === "COMPLETED") {
        setLoading(false);
      } else if (session && session.status !== "PROCESSING" && session.status !== "RECORDING") {
        setLoading(false);
      }
      return;
    }

    // Keep loading state while processing or recording
    setLoading(true);

    let progressInterval: NodeJS.Timeout;
    let fetchInterval: NodeJS.Timeout;
    let currentProgress = 0;

    // Simulate progress updates
    const updateProgress = () => {
      const messages = [
        "Processing audio chunks...",
        "Transcribing with AI...",
        "Generating summary...",
        "Finalizing transcript...",
      ];
      
      currentProgress += Math.random() * 15;
      if (currentProgress > 90) currentProgress = 90;
      
      setProgress(currentProgress);
      const messageIndex = Math.floor((currentProgress / 100) * messages.length);
      setStatusMessage(messages[Math.min(messageIndex, messages.length - 1)]);
    };

    progressInterval = setInterval(updateProgress, 800);

    let isPolling = false; // Prevent concurrent polls
    
    // Poll for session updates with controlled frequency
    const pollSession = async () => {
      if (isPolling) return; // Skip if already polling
      
      try {
        isPolling = true;
        const response = await fetch(`/api/sessions/${sessionId}`);
        if (response.ok) {
          const data = await response.json();
          if (data.session.status !== "PROCESSING" && data.session.status !== "RECORDING") {
            setSession(data.session);
            setProgress(100);
            setStatusMessage("Complete!");
            setLoading(false); // Stop loading when status changes from PROCESSING/RECORDING
            clearInterval(progressInterval);
            clearInterval(fetchInterval);
          } else {
            // Still processing or recording, update session data but keep loading
            setSession(data.session);
            // Update status message based on status
            if (data.session.status === "RECORDING") {
              setStatusMessage("Recording in progress...");
            }
          }
        }
      } catch (error) {
        console.error("Error polling session:", error);
      } finally {
        isPolling = false;
      }
    };

    // Poll every 2 seconds (reduced frequency to prevent excessive requests)
    fetchInterval = setInterval(pollSession, 2000);
    // Also poll immediately
    pollSession();

    return () => {
      clearInterval(progressInterval);
      clearInterval(fetchInterval);
    };
  }, [session, sessionId]);

  const handleFixTranscript = async () => {
    if (!session) return;

    setFixing(true);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/fix-transcript`, {
        method: "POST",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to fix transcript");
      }

      const data = await response.json();
      
      // Refresh session data
      const refreshResponse = await fetch(`/api/sessions/${sessionId}`);
      if (refreshResponse.ok) {
        const refreshData = await refreshResponse.json();
        setSession(refreshData.session);
      }
      
      toast.success(data.message || "Transcript fixed successfully!");
    } catch (error) {
      console.error("Error fixing transcript:", error);
      toast.error(error instanceof Error ? error.message : "Failed to fix transcript");
    } finally {
      setFixing(false);
    }
  };

  const handleRegenerateSummary = async () => {
    if (!session || !session.transcriptText) {
      return;
    }

    setRegenerating(true);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/regenerate-summary`, {
        method: "POST",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to regenerate summary");
      }

      const data = await response.json();
      
      // Update session with new summary
      setSession({ ...session, summary: data.summary });
      
      // Show success message
      toast.success("Summary regenerated successfully!");
    } catch (error) {
      console.error("Error regenerating summary:", error);
      toast.error(error instanceof Error ? error.message : "Failed to regenerate summary");
    } finally {
      setRegenerating(false);
    }
  };

  const handleExport = (format: "txt" | "json") => {
    if (!session) return;

    let content: string;
    let filename: string;
    let mimeType: string;

    if (format === "txt") {
      // Use transcriptText as primary source (it's the final combined transcript)
      const transcript = session.transcriptText || "No transcript available.\n";
      
      content = `Session: ${session.title || "Untitled"}\n`;
      content += `Date: ${new Date(session.createdAt).toLocaleString()}\n`;
      content += `Duration: ${session.duration ? `${Math.floor(session.duration / 60)}m ${session.duration % 60}s` : "N/A"}\n\n`;
      content += "=== TRANSCRIPT ===\n\n";
      content += transcript;
      if (session.summary) {
        content += "\n\n=== SUMMARY ===\n\n";
        content += session.summary;
      }
      filename = `session-${sessionId}.txt`;
      mimeType = "text/plain";
    } else {
      // Use transcriptText as primary source (it's the final combined transcript)
      content = JSON.stringify(
        {
          id: session.id,
          title: session.title,
          status: session.status,
          transcript: session.transcriptText,
          summary: session.summary,
          duration: session.duration,
          createdAt: session.createdAt,
          chunks: session.chunks, // Include chunks for reference but use transcriptText as primary
        },
        null,
        2
      );
      filename = `session-${sessionId}.json`;
      mimeType = "application/json";
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background via-background to-muted/20">
        <div className="text-center space-y-4">
          <LoadingLines />
          <p className="text-muted-foreground">Loading session...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Session not found</h1>
          <Link
            href="/sessions"
            className="mt-4 inline-block text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
          >
            Back to Sessions
          </Link>
        </div>
      </div>
    );
  }

  // Show processing/recording screen with progress
  if (session.status === "PROCESSING" || session.status === "RECORDING") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20 flex items-center justify-center">
        <Toaster />
        <div className="container mx-auto px-4 py-8">
          <div className="max-w-2xl mx-auto text-center space-y-8">
            <div>
              <LoadingLines />
            </div>
            <div className="space-y-4">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                {session.status === "RECORDING" ? "Recording in Progress" : "Processing Your Session"}
              </h2>
              <p className="text-muted-foreground">
                {session.status === "RECORDING" 
                  ? "Your session is being recorded. The transcript will appear here once processing is complete."
                  : statusMessage}
              </p>
              <div className="space-y-2">
                <Progress value={progress} className="w-full" />
                <p className="text-sm text-muted-foreground">{Math.round(progress)}%</p>
              </div>
            </div>
            <Link
              href="/sessions"
              className="inline-block text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
            >
              ← Back to Sessions
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
      <Toaster />
      <div className="container mx-auto px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <Link
              href="/sessions"
              className="mb-2 inline-block text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
            >
              ← Back to Sessions
            </Link>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
              {session.title || "Untitled Session"}
            </h1>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={handleFixTranscript}
              disabled={fixing}
              variant="destructive"
              size="sm"
            >
              {fixing ? "Fixing..." : "Fix Transcript"}
            </Button>
            <Button
              onClick={() => handleExport("txt")}
              variant="outline"
            >
              Export TXT
            </Button>
            <Button
              onClick={() => handleExport("json")}
              variant="outline"
            >
              Export JSON
            </Button>
          </div>
        </div>

        <div className="mx-auto max-w-4xl space-y-6">
          {/* Session Info */}
          <Card>
            <CardHeader>
              <CardTitle>Session Information</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="font-medium text-muted-foreground">Status:</span>
                  <span className="ml-2">{session.status}</span>
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">Duration:</span>
                  <span className="ml-2">
                    {session.duration
                      ? `${Math.floor(session.duration / 60)}m ${session.duration % 60}s`
                      : "N/A"}
                  </span>
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">Created:</span>
                  <span className="ml-2">
                    {new Date(session.createdAt).toLocaleString()}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Summary */}
          {session.summary && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Summary</CardTitle>
                  {session.transcriptText && (
                    <Button
                      onClick={handleRegenerateSummary}
                      disabled={regenerating}
                      size="sm"
                      variant="outline"
                    >
                      {regenerating ? "Regenerating..." : "Regenerate"}
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="prose max-w-none">
                  <pre className="whitespace-pre-wrap font-sans text-sm">{session.summary}</pre>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Transcript */}
          <Card>
            <CardHeader>
              <CardTitle>Transcript</CardTitle>
            </CardHeader>
            <CardContent>
              {session.transcriptText ? (
                <div className="prose max-w-none">
                  <pre className="whitespace-pre-wrap font-sans text-sm">{session.transcriptText}</pre>
                </div>
              ) : (
                <p className="text-muted-foreground">No transcript available.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

