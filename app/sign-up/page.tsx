"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FullScreenSignup } from "@/components/ui/full-screen-signup";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

export default function SignUpPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (data: { name?: string; email: string; password: string }) => {
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: data.name, email: data.email, password: data.password }),
      });

      let responseData;
      try {
        const text = await response.text();
        responseData = text ? JSON.parse(text) : {};
      } catch (parseError) {
        throw new Error("Invalid response from server");
      }

      if (!response.ok) {
        throw new Error(responseData.message || responseData.error || "Sign up failed");
      }

      toast.success("Account created successfully!");
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
      <FullScreenSignup mode="signup" onSubmit={handleSubmit} loading={loading} error={error} />
    </>
  );
}
