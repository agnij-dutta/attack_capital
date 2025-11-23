"use client";

import { Mic } from "lucide-react";
import { useState } from "react";
import Link from "next/link";

interface FullScreenSignupProps {
  mode: "signup" | "signin";
  onSubmit: (data: { name?: string; email: string; password: string }) => Promise<void>;
  loading?: boolean;
  error?: string;
}

export const FullScreenSignup = ({ mode, onSubmit, loading = false, error }: FullScreenSignupProps) => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [nameError, setNameError] = useState("");

  const validateEmail = (value: string) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  };

  const validatePassword = (value: string) => {
    return value.length >= 8;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let valid = true;

    if (mode === "signup" && !name.trim()) {
      setNameError("Name is required.");
      valid = false;
    } else {
      setNameError("");
    }

    if (!validateEmail(email)) {
      setEmailError("Please enter a valid email address.");
      valid = false;
    } else {
      setEmailError("");
    }

    if (!validatePassword(password)) {
      setPasswordError("Password must be at least 8 characters.");
      valid = false;
    } else {
      setPasswordError("");
    }

    if (valid) {
      try {
        await onSubmit({ ...(mode === "signup" && { name }), email, password });
      } catch (err) {
        // Error handling is done in parent component
      }
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center overflow-hidden p-4">
      <div className="w-full relative max-w-5xl overflow-hidden flex flex-col md:flex-row shadow-xl rounded-2xl">
        {/* Decorative elements */}
        <div className="w-full h-full z-2 absolute bg-gradient-to-t from-transparent to-black/20"></div>
        <div className="flex absolute z-2 overflow-hidden backdrop-blur-2xl">
          {[...Array(6)].map((_, i) => (
            <div
              key={i}
              className="h-[40rem] z-2 w-[4rem] bg-gradient-to-r from-transparent via-black/30 to-transparent/30 opacity-20 overflow-hidden"
            />
          ))}
        </div>
        <div className="w-[15rem] h-[15rem] bg-indigo-500/30 absolute z-1 rounded-full bottom-0 blur-3xl"></div>
        <div className="w-[8rem] h-[5rem] bg-purple-500/20 absolute z-1 rounded-full bottom-0 blur-2xl"></div>

        {/* Left side - Branding */}
        <div className="bg-gradient-to-br from-indigo-600 to-purple-600 text-white p-8 md:p-12 md:w-1/2 relative rounded-bl-3xl overflow-hidden">
          <div className="relative z-10 h-full flex flex-col justify-center">
            <div className="mb-8">
              <div className="w-16 h-16 bg-white/20 backdrop-blur-sm rounded-2xl flex items-center justify-center mb-6">
                <Mic className="h-8 w-8 text-white" />
              </div>
              <h1 className="text-3xl md:text-4xl font-bold leading-tight tracking-tight mb-4">
                ScribeAI
              </h1>
              <p className="text-lg opacity-90">
                {mode === "signup"
                  ? "Transform your conversations into actionable insights with AI-powered transcription."
                  : "Welcome back! Sign in to continue your transcription journey."}
              </p>
            </div>
          </div>
        </div>

        {/* Right side - Form */}
        <div className="p-8 md:p-12 md:w-1/2 flex flex-col bg-background z-10 text-foreground">
          <div className="flex flex-col items-left mb-8">
            <h2 className="text-3xl font-bold mb-2 tracking-tight">
              {mode === "signup" ? "Create Account" : "Welcome Back"}
            </h2>
            <p className="text-left text-muted-foreground">
              {mode === "signup"
                ? "Get started with ScribeAI"
                : "Sign in to your ScribeAI account"}
            </p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm">
              {error}
            </div>
          )}

          <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
            {mode === "signup" && (
              <div>
                <label htmlFor="name" className="block text-sm font-medium mb-2">
                  Name
                </label>
                <input
                  type="text"
                  id="name"
                  placeholder="John Doe"
                  className={`text-sm w-full py-2 px-3 border rounded-lg focus:outline-none focus:ring-2 bg-background text-foreground focus:ring-indigo-500 ${
                    nameError ? "border-destructive" : "border-border"
                  }`}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameError("");
                  }}
                  disabled={loading}
                  aria-invalid={!!nameError}
                  aria-describedby="name-error"
                />
                {nameError && (
                  <p id="name-error" className="text-destructive text-xs mt-1">
                    {nameError}
                  </p>
                )}
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-sm font-medium mb-2">
                Email
              </label>
              <input
                type="email"
                id="email"
                placeholder="you@example.com"
                className={`text-sm w-full py-2 px-3 border rounded-lg focus:outline-none focus:ring-2 bg-background text-foreground focus:ring-indigo-500 ${
                  emailError ? "border-destructive" : "border-border"
                }`}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setEmailError("");
                }}
                disabled={loading}
                aria-invalid={!!emailError}
                aria-describedby="email-error"
              />
              {emailError && (
                <p id="email-error" className="text-destructive text-xs mt-1">
                  {emailError}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium mb-2">
                Password
              </label>
              <input
                type="password"
                id="password"
                placeholder="••••••••"
                className={`text-sm w-full py-2 px-3 border rounded-lg focus:outline-none focus:ring-2 bg-background text-foreground focus:ring-indigo-500 ${
                  passwordError ? "border-destructive" : "border-border"
                }`}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPasswordError("");
                }}
                disabled={loading}
                aria-invalid={!!passwordError}
                aria-describedby="password-error"
              />
              {passwordError && (
                <p id="password-error" className="text-destructive text-xs mt-1">
                  {passwordError}
                </p>
              )}
              {mode === "signup" && (
                <p className="text-xs text-muted-foreground mt-1">
                  Must be at least 8 characters
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading
                ? mode === "signup"
                  ? "Creating account..."
                  : "Signing in..."
                : mode === "signup"
                ? "Create Account"
                : "Sign In"}
            </button>

            <div className="text-center text-muted-foreground text-sm">
              {mode === "signup" ? (
                <>
                  Already have an account?{" "}
                  <Link href="/sign-in" className="text-indigo-600 hover:text-indigo-700 font-medium underline">
                    Sign in
                  </Link>
                </>
              ) : (
                <>
                  Don't have an account?{" "}
                  <Link href="/sign-up" className="text-indigo-600 hover:text-indigo-700 font-medium underline">
                    Sign up
                  </Link>
                </>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
