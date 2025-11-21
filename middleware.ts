import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

/**
 * Middleware to protect routes
 * Redirects unauthenticated users to sign-in page
 */
export async function middleware(request: NextRequest) {
  // Public routes that don't require authentication
  const publicRoutes = ["/", "/sign-in", "/sign-up"];
  const isPublicRoute = publicRoutes.some((route) => request.nextUrl.pathname === route);

  if (isPublicRoute) {
    return NextResponse.next();
  }

  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      const signInUrl = new URL("/sign-in", request.url);
      signInUrl.searchParams.set("redirect", request.nextUrl.pathname);
      return NextResponse.redirect(signInUrl);
    }

    return NextResponse.next();
  } catch (error) {
    const signInUrl = new URL("/sign-in", request.url);
    return NextResponse.redirect(signInUrl);
  }
}

export const config = {
  matcher: ["/dashboard/:path*", "/sessions/:path*"],
};

