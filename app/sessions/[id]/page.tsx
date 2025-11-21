"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";

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

  const handleExport = (format: "txt" | "json") => {
    if (!session) return;

    let content: string;
    let filename: string;
    let mimeType: string;

    if (format === "txt") {
      content = `Session: ${session.title || "Untitled"}\n`;
      content += `Date: ${new Date(session.createdAt).toLocaleString()}\n`;
      content += `Duration: ${session.duration ? `${Math.floor(session.duration / 60)}m ${session.duration % 60}s` : "N/A"}\n\n`;
      content += "=== TRANSCRIPT ===\n\n";
      content += session.transcriptText || "No transcript available.\n";
      if (session.summary) {
        content += "\n\n=== SUMMARY ===\n\n";
        content += session.summary;
      }
      filename = `session-${sessionId}.txt`;
      mimeType = "text/plain";
    } else {
      content = JSON.stringify(
        {
          id: session.id,
          title: session.title,
          status: session.status,
          transcript: session.transcriptText,
          summary: session.summary,
          duration: session.duration,
          createdAt: session.createdAt,
          chunks: session.chunks,
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
              <h2 className="mb-4 text-2xl font-semibold text-gray-900 dark:text-white">
                Summary
              </h2>
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

