import { NextRequest, NextResponse } from "next/server";

/**
 * Middleware to protect routes
 * Uses cookie-based check to avoid Prisma in Edge runtime
 * Redirects unauthenticated users to sign-in page
 */
export async function middleware(request: NextRequest) {
  // Public routes that don't require authentication
  const publicRoutes = ["/", "/sign-in", "/sign-up"];
  const isPublicRoute = publicRoutes.some((route) => request.nextUrl.pathname === route);

  if (isPublicRoute) {
    return NextResponse.next();
  }

  // Check for Better Auth session cookie
  // Better Auth uses 'better-auth.session_token' cookie
  const sessionToken = request.cookies.get("better-auth.session_token");

  if (!sessionToken) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set("redirect", request.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/sessions/:path*"],
  runtime: "nodejs", // Use Node.js runtime to support Prisma if needed
};

