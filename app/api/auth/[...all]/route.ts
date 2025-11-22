import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

/**
 * Better Auth API route handler for Next.js App Router
 * Handles all authentication endpoints (sign-in, sign-up, sign-out, etc.)
 */
export const { GET, POST } = toNextJsHandler(auth.handler);
