import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

/**
 * Fix transcript by rebuilding it from only the correct chunks for this session
 * This removes any orphaned or incorrectly associated chunks
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const dbSession = await prisma.recordingSession.findUnique({
      where: { id },
      include: {
        chunks: {
          orderBy: { chunkIndex: "asc" },
        },
      },
    });

    if (!dbSession) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (dbSession.userId !== session.user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Get only chunks that belong to this session (double-check sessionId)
    const validChunks = dbSession.chunks.filter(
      (chunk) => chunk.sessionId === id
    );

    // Rebuild transcript from valid chunks only
    const fixedTranscript = validChunks
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((chunk) => chunk.text.trim())
      .filter((text) => {
        if (!text || text.length === 0) return false;
        const lowerText = text.toLowerCase();
        // Filter out error messages
        if (
          lowerText.includes("the audio appears to be silent") ||
          lowerText.includes("cannot provide a transcription") ||
          lowerText.includes("no discernible speech") ||
          lowerText.includes("okay, here's the transcription")
        ) {
          return false;
        }
        return true;
      })
      .join("\n\n");

    // Update session with fixed transcript
    const updatedSession = await prisma.recordingSession.update({
      where: { id },
      data: { transcriptText: fixedTranscript },
    });

    // Delete any chunks that don't belong to this session (orphaned chunks)
    const orphanedChunks = dbSession.chunks.filter(
      (chunk) => chunk.sessionId !== id
    );
    
    if (orphanedChunks.length > 0) {
      await prisma.transcriptChunk.deleteMany({
        where: {
          id: { in: orphanedChunks.map((c) => c.id) },
        },
      });
    }

    return NextResponse.json({
      success: true,
      transcript: fixedTranscript,
      removedChunks: orphanedChunks.length,
      message: `Fixed transcript. Removed ${orphanedChunks.length} orphaned chunks.`,
    });
  } catch (error) {
    console.error("Error fixing transcript:", error);
    return NextResponse.json(
      { error: "Failed to fix transcript" },
      { status: 500 }
    );
  }
}

