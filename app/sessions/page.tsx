"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import LoadingLines from "@/components/ui/loading-lines";
import { Search } from "lucide-react";

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
  const [searchQuery, setSearchQuery] = useState("");

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

  // Filter sessions based on search query
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) {
      return sessions;
    }

    const query = searchQuery.toLowerCase();
    return sessions.filter((session) => {
      // Search in title
      if (session.title?.toLowerCase().includes(query)) {
        return true;
      }
      // Search in transcript
      if (session.transcriptText?.toLowerCase().includes(query)) {
        return true;
      }
      // Search in summary
      if (session.summary?.toLowerCase().includes(query)) {
        return true;
      }
      return false;
    });
  }, [sessions, searchQuery]);

  // Generate preview snippet from transcript or summary
  const getPreviewSnippet = (session: Session): string => {
    if (session.summary) {
      // Extract first meaningful sentence from summary
      const summaryLines = session.summary.split("\n");
      const firstLine = summaryLines.find((line) => line.trim().length > 20);
      if (firstLine) {
        return firstLine.trim().substring(0, 150) + (firstLine.length > 150 ? "..." : "");
      }
    }
    if (session.transcriptText) {
      // Extract first meaningful sentence from transcript
      const sentences = session.transcriptText.split(/[.!?]\s+/);
      const firstSentence = sentences.find((s) => s.trim().length > 20);
      if (firstSentence) {
        return firstSentence.trim().substring(0, 150) + (firstSentence.length > 150 ? "..." : "");
      }
      // Fallback to first 150 chars
      return session.transcriptText.substring(0, 150) + (session.transcriptText.length > 150 ? "..." : "");
    }
    return "No transcript available";
  };


  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background via-background to-muted/20">
        <div className="text-center space-y-4">
          <LoadingLines />
          <p className="text-muted-foreground">Loading sessions...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-4xl font-bold tracking-tight">Sessions</h1>
              <p className="mt-2 text-muted-foreground">
                View and manage your recording sessions
              </p>
            </div>
            <div className="flex gap-2">
              <Button asChild>
                <Link href="/dashboard">New Session</Link>
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  await fetch("/api/auth/sign-out", { method: "POST" });
                  router.push("/sign-in");
                }}
              >
                Sign Out
              </Button>
            </div>
          </div>
          
          {/* Search Input */}
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <Input
              type="text"
              placeholder="Search sessions by title, transcript, or summary..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>

        {sessions.length === 0 ? (
          <Card className="text-center">
            <CardContent className="pt-6">
              <p className="text-muted-foreground mb-4">No sessions yet.</p>
              <Button asChild>
                <Link href="/dashboard">Start Your First Session</Link>
              </Button>
            </CardContent>
          </Card>
        ) : filteredSessions.length === 0 ? (
          <Card className="text-center">
            <CardContent className="pt-6">
              <p className="text-muted-foreground mb-4">
                No sessions found matching "{searchQuery}"
              </p>
              <Button variant="outline" onClick={() => setSearchQuery("")}>
                Clear Search
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredSessions.map((session) => (
              <Link key={session.id} href={`/sessions/${session.id}`}>
                <Card className="h-full transition-all hover:shadow-lg hover:scale-[1.02] cursor-pointer">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg">
                        {session.title || "Untitled Session"}
                      </CardTitle>
                      <Badge
                        variant={
                          session.status === "COMPLETED"
                            ? "default"
                            : session.status === "PROCESSING"
                            ? "secondary"
                            : "destructive"
                        }
                      >
                        {session.status}
                      </Badge>
                    </div>
                    <CardDescription>
                      {formatDate(session.createdAt)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground mb-2">
                      Duration: {formatDuration(session.duration)}
                    </p>
                    <p className="line-clamp-3 text-sm text-muted-foreground">
                      {getPreviewSnippet(session)}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

