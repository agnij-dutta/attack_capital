"use client";

import { Mic } from "lucide-react";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

interface AIVoiceInputProps {
  onStart?: () => void;
  onStop?: (duration: number) => void;
  visualizerBars?: number;
  demoMode?: boolean;
  demoInterval?: number;
  className?: string;
  isRecording?: boolean; // Add controlled recording state
  externalTime?: number; // External time to sync with actual recording time
}

export function AIVoiceInput({
  onStart,
  onStop,
  visualizerBars = 64,
  demoMode = false,
  demoInterval = 3000,
  className,
  isRecording: externalIsRecording,
  externalTime
}: AIVoiceInputProps) {
  const [submitted, setSubmitted] = useState(false);
  const [time, setTime] = useState(0);
  const [isClient, setIsClient] = useState(false);
  const [isDemo, setIsDemo] = useState(demoMode);
  const [barHeights, setBarHeights] = useState<number[]>(Array(visualizerBars).fill(20));
  
  // Use external isRecording if provided, otherwise use internal submitted state
  const isActive = externalIsRecording !== undefined ? externalIsRecording : submitted;
  
  // Use external time if provided, otherwise use internal time
  const displayTime = externalTime !== undefined ? externalTime : time;
  
  // Update bar heights continuously when active
  useEffect(() => {
    if (!isActive || !isClient) {
      setBarHeights(Array(visualizerBars).fill(20));
      return;
    }
    
    const interval = setInterval(() => {
      setBarHeights(Array(visualizerBars).fill(0).map(() => 20 + Math.random() * 80));
    }, 100);
    
    return () => clearInterval(interval);
  }, [isActive, isClient, visualizerBars]);

  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    let intervalId: NodeJS.Timeout;

    if (externalIsRecording !== undefined) {
      // Controlled mode - use external state
      if (externalIsRecording) {
        onStart?.();
        // Only update internal time if external time is not provided
        if (externalTime === undefined) {
          intervalId = setInterval(() => {
            setTime((t) => t + 1);
          }, 1000);
        }
      } else {
        onStop?.(displayTime);
        setTime(0);
      }
    } else {
      // Uncontrolled mode - use internal state
      if (submitted) {
        onStart?.();
        intervalId = setInterval(() => {
          setTime((t) => t + 1);
        }, 1000);
      } else {
        onStop?.(time);
        setTime(0);
      }
    }

    return () => clearInterval(intervalId);
  }, [submitted, externalIsRecording, externalTime, displayTime, time, onStart, onStop]);

  useEffect(() => {
    if (!isDemo) return;

    let timeoutId: NodeJS.Timeout;
    const runAnimation = () => {
      setSubmitted(true);
      timeoutId = setTimeout(() => {
        setSubmitted(false);
        timeoutId = setTimeout(runAnimation, 1000);
      }, demoInterval);
    };

    const initialTimeout = setTimeout(runAnimation, 100);
    return () => {
      clearTimeout(timeoutId);
      clearTimeout(initialTimeout);
    };
  }, [isDemo, demoInterval]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const handleClick = () => {
    if (isDemo) {
      setIsDemo(false);
      setSubmitted(false);
    } else {
      setSubmitted((prev) => !prev);
    }
  };

  return (
    <div className={cn("w-full py-8", className)}>
      <div className="relative w-full mx-auto flex items-center flex-col gap-6">
        {/* Large Mic Icon */}
        <div className="relative">
          <button
            className={cn(
              "group w-24 h-24 rounded-2xl flex items-center justify-center transition-colors",
              isActive
                ? "bg-none"
                : "bg-none hover:bg-black/10 dark:hover:bg-white/10"
            )}
            type="button"
            onClick={externalIsRecording === undefined ? handleClick : undefined}
            disabled={externalIsRecording !== undefined}
          >
            {isActive ? (
              <div
                className="w-12 h-12 rounded-lg animate-spin bg-indigo-600 dark:bg-indigo-500 cursor-pointer pointer-events-auto"
                style={{ animationDuration: "3s" }}
              />
            ) : (
              <Mic className="w-12 h-12 text-foreground/70" />
            )}
          </button>
        </div>

        {/* Large Timer */}
        <div className="text-center">
          <span
            className={cn(
              "font-mono text-6xl font-bold transition-opacity duration-300",
              isActive
                ? "text-foreground"
                : "text-muted-foreground"
            )}
          >
            {formatTime(displayTime)}
          </span>
        </div>

        {/* Large Visualizer */}
        <div className="h-8 w-full max-w-2xl flex items-center justify-center gap-1">
          {[...Array(visualizerBars)].map((_, i) => (
            <div
              key={i}
              className={cn(
                "w-1 rounded-full transition-all duration-100",
                isActive
                  ? "bg-indigo-500 dark:bg-indigo-400"
                  : "bg-muted h-2"
              )}
              style={{
                height: isActive && barHeights[i] ? `${barHeights[i]}%` : "8px",
              }}
            />
          ))}
        </div>

        {/* Status Text */}
        <p className="h-6 text-sm font-medium text-muted-foreground">
          {isActive ? "Listening..." : "Click to speak"}
        </p>
      </div>
    </div>
  );
}