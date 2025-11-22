import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { generateSummary } from "@/lib/gemini";

/**
 * Regenerate summary for a session
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
      where: {
        id,
      },
    });

    if (!dbSession) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (dbSession.userId !== session.user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!dbSession.transcriptText) {
      return NextResponse.json(
        { error: "Cannot regenerate summary: transcript is not available" },
        { status: 400 }
      );
    }

    // Generate new summary from transcriptText
    const newSummary = await generateSummary(dbSession.transcriptText);

    // Update session with new summary
    const updatedSession = await prisma.recordingSession.update({
      where: { id },
      data: { summary: newSummary },
    });

    return NextResponse.json({ 
      success: true,
      summary: updatedSession.summary 
    });
  } catch (error) {
    console.error("Error regenerating summary:", error);
    return NextResponse.json(
      { error: "Failed to regenerate summary" },
      { status: 500 }
    );
  }
}

