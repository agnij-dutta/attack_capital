"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import LoadingLines from "@/components/ui/loading-lines";

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
        <div className="mb-8 flex items-center justify-between">
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

        {sessions.length === 0 ? (
          <Card className="text-center">
            <CardContent className="pt-6">
              <p className="text-muted-foreground mb-4">No sessions yet.</p>
              <Button asChild>
                <Link href="/dashboard">Start Your First Session</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {sessions.map((session) => (
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
                    {session.transcriptText && (
                      <p className="line-clamp-2 text-sm text-muted-foreground">
                        {session.transcriptText.substring(0, 100)}
                        {session.transcriptText.length > 100 ? "..." : ""}
                      </p>
                    )}
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

