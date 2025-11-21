"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Session {
  id: string;
  title: string | null;
  status: string;
  transcriptText: string | null;
  summary: string | null;
  duration: number | null;
  createdAt: string;
  updatedAt: string;
}

export default function SessionsPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchSessions() {
      try {
        const response = await fetch("/api/sessions");
        if (response.status === 401) {
          router.push("/sign-in");
          return;
        }
        const data = await response.json();
        setSessions(data.sessions || []);
      } catch (error) {
        console.error("Error fetching sessions:", error);
      } finally {
        setLoading(false);
      }
    }
    fetchSessions();
  }, [router]);

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "N/A";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "COMPLETED":
        return "bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400";
      case "RECORDING":
        return "bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400";
      case "PROCESSING":
        return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400";
      case "PAUSED":
        return "bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400";
      default:
        return "bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400";
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Sessions</h1>
          <div className="flex gap-4">
            <Link
              href="/dashboard"
              className="rounded-lg bg-indigo-600 px-4 py-2 text-white transition-colors hover:bg-indigo-700"
            >
              New Session
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

        {sessions.length === 0 ? (
          <div className="rounded-2xl bg-white p-8 text-center shadow-xl dark:bg-gray-800">
            <p className="text-gray-600 dark:text-gray-400">No sessions yet.</p>
            <Link
              href="/dashboard"
              className="mt-4 inline-block rounded-lg bg-indigo-600 px-6 py-3 text-white transition-colors hover:bg-indigo-700"
            >
              Start Your First Session
            </Link>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {sessions.map((session) => (
              <Link
                key={session.id}
                href={`/sessions/${session.id}`}
                className="rounded-2xl bg-white p-6 shadow-xl transition-transform hover:scale-105 dark:bg-gray-800"
              >
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    {session.title || "Untitled Session"}
                  </h3>
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-medium ${getStatusColor(session.status)}`}
                  >
                    {session.status}
                  </span>
                </div>
                <p className="mb-2 text-sm text-gray-600 dark:text-gray-400">
                  {formatDate(session.createdAt)}
                </p>
                <p className="mb-2 text-sm text-gray-600 dark:text-gray-400">
                  Duration: {formatDuration(session.duration)}
                </p>
                {session.transcriptText && (
                  <p className="line-clamp-2 text-sm text-gray-700 dark:text-gray-300">
                    {session.transcriptText.substring(0, 100)}
                    {session.transcriptText.length > 100 ? "..." : ""}
                  </p>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

