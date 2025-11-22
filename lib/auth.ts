import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma";

/**
 * Better Auth configuration for email/password authentication
 */
export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // Set to true in production
    minPasswordLength: 8,
    maxPasswordLength: 128,
    autoSignIn: true,
  },
  secret: process.env.BETTER_AUTH_SECRET || "change-this-secret",
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  trustedOrigins: [
    process.env.BETTER_AUTH_URL || "http://localhost:3000",
    "http://localhost:3000",
  ],
});

export type Session = typeof auth.$Infer.Session;

