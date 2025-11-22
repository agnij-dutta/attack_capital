"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

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

  useEffect(() => {
    async function fetchSession() {
      try {
        const response = await fetch(`/api/sessions/${sessionId}`);
        if (response.status === 401) {
          router.push("/sign-in");
          return;
        }
        if (response.status === 404) {
          router.push("/sessions");
          return;
        }
        const data = await response.json();
        setSession(data.session);
      } catch (error) {
        console.error("Error fetching session:", error);
      } finally {
        setLoading(false);
      }
    }
    if (sessionId) {
      fetchSession();
    }
  }, [sessionId, router]);

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
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent"></div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center">
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
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
            {/* <button
              onClick={handleFixTranscript}
              disabled={fixing}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white transition-colors hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-red-500 dark:hover:bg-red-600"
            >
              {fixing ? "Fixing..." : "Fix Transcript"}
            </button> */}
            <button
              onClick={() => handleExport("txt")}
              className="rounded-lg bg-white px-4 py-2 text-gray-700 shadow-sm transition-colors hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Export TXT
            </button>
            <button
              onClick={() => handleExport("json")}
              className="rounded-lg bg-white px-4 py-2 text-gray-700 shadow-sm transition-colors hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Export JSON
            </button>
          </div>
        </div>

        <div className="mx-auto max-w-4xl space-y-6">
          {/* Session Info */}
          <div className="rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="font-medium text-gray-600 dark:text-gray-400">Status:</span>
                <span className="ml-2 text-gray-900 dark:text-white">{session.status}</span>
              </div>
              <div>
                <span className="font-medium text-gray-600 dark:text-gray-400">Duration:</span>
                <span className="ml-2 text-gray-900 dark:text-white">
                  {session.duration
                    ? `${Math.floor(session.duration / 60)}m ${session.duration % 60}s`
                    : "N/A"}
                </span>
              </div>
              <div>
                <span className="font-medium text-gray-600 dark:text-gray-400">Created:</span>
                <span className="ml-2 text-gray-900 dark:text-white">
                  {new Date(session.createdAt).toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          {/* Summary */}
          {session.summary && (
            <div className="rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
                  Summary
                </h2>
                {session.transcriptText && (
                  <button
                    onClick={handleRegenerateSummary}
                    disabled={regenerating}
                    className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-indigo-500 dark:hover:bg-indigo-600"
                  >
                    {regenerating ? "Regenerating..." : "Regenerate Summary"}
                  </button>
                )}
              </div>
              <div className="prose max-w-none text-gray-700 dark:text-gray-300">
                <pre className="whitespace-pre-wrap font-sans">{session.summary}</pre>
              </div>
            </div>
          )}

          {/* Transcript */}
          <div className="rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
            <h2 className="mb-4 text-2xl font-semibold text-gray-900 dark:text-white">
              Transcript
            </h2>
            {session.transcriptText ? (
              <div className="prose max-w-none text-gray-700 dark:text-gray-300">
                <pre className="whitespace-pre-wrap font-sans">{session.transcriptText}</pre>
              </div>
            ) : (
              <p className="text-gray-600 dark:text-gray-400">No transcript available.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

