import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Mic, Video } from "lucide-react";

export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950 p-4">
      <Card className="w-full max-w-md shadow-2xl">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-600">
            <Mic className="h-8 w-8 text-white" />
          </div>
          <CardTitle className="text-3xl font-bold">ScribeAI</CardTitle>
          <CardDescription className="text-base">
            AI-Powered Meeting Transcription
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button asChild className="w-full" size="lg">
            <Link href="/sign-in">Sign In</Link>
          </Button>
          <Button asChild variant="outline" className="w-full" size="lg">
            <Link href="/sign-up">Sign Up</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
