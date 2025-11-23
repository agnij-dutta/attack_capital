"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FullScreenSignup } from "@/components/ui/full-screen-signup";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

export default function SignInPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (data: { email: string; password: string }) => {
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: data.email, password: data.password }),
      });

      let responseData;
      try {
        const text = await response.text();
        responseData = text ? JSON.parse(text) : {};
      } catch (parseError) {
        throw new Error("Invalid response from server");
      }

      if (!response.ok) {
        throw new Error(responseData.message || responseData.error || "Sign in failed");
      }

      toast.success("Signed in successfully!");
      router.push("/dashboard");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "An error occurred";
      setError(errorMessage);
      toast.error(errorMessage);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Toaster />
      <FullScreenSignup mode="signin" onSubmit={handleSubmit} loading={loading} error={error} />
    </>
  );
}
