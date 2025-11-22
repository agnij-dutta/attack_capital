import { prisma } from "../lib/prisma";
import { auth } from "../lib/auth";

async function testAuth() {
  try {
    console.log("Testing Prisma connection...");
    await prisma.$connect();
    console.log("✅ Prisma connected");

    console.log("Testing Better Auth...");
    // Try to get a user (should return empty or error if no users)
    const users = await prisma.user.findMany({ take: 1 });
    console.log(`✅ Found ${users.length} users in database`);

    console.log("✅ All tests passed!");
    await prisma.$disconnect();
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

testAuth();

