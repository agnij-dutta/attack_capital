import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { headers } from "next/headers";

/**
 * Get current user session
 */
export async function GET() {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    return NextResponse.json({ user: session?.user || null });
  } catch (error) {
    return NextResponse.json({ user: null }, { status: 401 });
  }
}

