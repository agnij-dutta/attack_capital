import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFile, unlink } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

const execAsync = promisify(exec);

// Load .env from server directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "../.env") });

// Also try loading from parent directory (root .env)
if (!process.env.GEMINI_API_KEY) {
  dotenv.config({ path: join(__dirname, "../../.env") });
}

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not set in environment variables");
}

/**
 * Gemini API client for transcription and summarization
 */
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

/**
 * Convert audio from WebM/OGG to MP3 (Gemini supported format)
 * Uses ffmpeg for conversion
 * 
 * Gemini API supports: WAV, MP3, AIFF, AAC, OGG Vorbis, FLAC
 * Browser MediaRecorder typically outputs: WebM (not supported)
 * This function converts WebM to MP3 for Gemini compatibility
 */
async function convertAudioToMP3(
  base64Audio: string,
  inputMimeType: string
): Promise<string> {
  // Determine input file extension based on mimeType
  const getInputExtension = (mime: string): string => {
    if (mime.includes("webm")) return "webm";
    if (mime.includes("ogg")) return "ogg";
    return "webm"; // default
  };
  // Check if ffmpeg is available
  try {
    await execAsync("ffmpeg -version");
  } catch (error) {
    throw new Error(
      "FFmpeg is not installed. Please install FFmpeg to enable audio conversion.\n" +
      "Installation: macOS: brew install ffmpeg | Ubuntu: sudo apt install ffmpeg | Windows: choco install ffmpeg"
    );
  }

  const tempDir = tmpdir();
  const inputExt = getInputExtension(inputMimeType);
  const inputFile = join(tempDir, `input-${randomUUID()}.${inputExt}`);
  const outputFile = join(tempDir, `output-${randomUUID()}.mp3`);

  try {
    // Decode base64 and write to temp file
    const audioBuffer = Buffer.from(base64Audio, "base64");
    await writeFile(inputFile, audioBuffer);

    // Convert using ffmpeg
    // -y: overwrite output file
    // -i: input file
    // -acodec libmp3lame: use MP3 codec
    // -ar 16000: sample rate 16kHz (Gemini downsamples to 16kHz anyway)
    // -ac 1: mono channel (Gemini combines channels anyway)
    // -b:a 64k: bitrate 64kbps (sufficient for speech)
    // -f mp3: force MP3 format
    // -loglevel error: only show errors (reduce noise)
    const ffmpegCommand = `ffmpeg -y -loglevel error -i "${inputFile}" -acodec libmp3lame -ar 16000 -ac 1 -b:a 64k -f mp3 "${outputFile}"`;
    
    try {
      await execAsync(ffmpegCommand, { 
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
        timeout: 30000, // 30 second timeout
      });
    } catch (execError: any) {
      // Check if output file exists despite error (ffmpeg sometimes reports errors but succeeds)
      const { existsSync, statSync } = await import("fs");
      if (existsSync(outputFile)) {
        const stats = statSync(outputFile);
        if (stats.size > 0) {
          // File exists and has content, conversion likely succeeded
          console.warn("[Gemini] FFmpeg reported error but file was created successfully");
        } else {
          throw new Error("FFmpeg output file is empty");
        }
      } else {
        // File doesn't exist, conversion failed
        const errorMsg = execError.stderr || execError.stdout || execError.message || String(execError);
        console.error("[Gemini] FFmpeg conversion failed:", errorMsg.substring(0, 500));
        throw new Error(`FFmpeg conversion failed: ${errorMsg.substring(0, 200)}`);
      }
    }
    
    // Verify output file was created and has content
    const { existsSync, statSync } = await import("fs");
    if (!existsSync(outputFile)) {
      throw new Error("FFmpeg output file was not created");
    }
    
    const stats = statSync(outputFile);
    if (stats.size === 0) {
      throw new Error("FFmpeg output file is empty");
    }

    // Read converted file and encode to base64
    const { readFile } = await import("fs/promises");
    const convertedBuffer = await readFile(outputFile);
    const convertedBase64 = convertedBuffer.toString("base64");

    // Cleanup temp files
    await unlink(inputFile).catch(() => {});
    await unlink(outputFile).catch(() => {});

    return convertedBase64;
  } catch (error) {
    // Cleanup on error
    await unlink(inputFile).catch(() => {});
    await unlink(outputFile).catch(() => {});
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[Gemini] FFmpeg conversion error:", errorMessage);
    throw new Error(`Audio conversion failed: ${errorMessage}`);
  }
}

/**
 * Transcribes an audio chunk using Gemini API
 * @param audioData - Base64 encoded audio data
 * @param mimeType - MIME type of the audio (e.g., 'audio/webm', 'audio/mpeg')
 * @param previousContext - Optional previous transcript chunks for context continuity
 * @returns Transcribed text with speaker diarization if available
 */
export async function transcribeAudio(
  audioData: string,
  mimeType: string = "audio/webm",
  previousContext?: string
): Promise<string> {
  try {
    // Validate audio data
    if (!audioData || audioData.length === 0) {
      console.warn("[Gemini] Empty audio data provided for transcription");
      return "[silence]";
    }

    // Check if audio data is too small (likely silence/empty)
    // Increased threshold to ensure we have enough audio for accurate transcription
    if (audioData.length < 2000) {
      console.warn(`[Gemini] Audio data too small (${audioData.length} bytes), likely silence`);
      return "[silence]";
    }

    // Convert WebM to MP3 (Gemini supported format) if needed
    let finalAudioData = audioData;
    let finalMimeType = mimeType || "audio/webm";
    
    // Check if we need to convert (WebM is not supported by Gemini)
    // Gemini supports: WAV, MP3, AIFF, AAC, OGG Vorbis, FLAC
    // OGG is supported, so we only convert WebM
    const supportedFormats = ["audio/mp3", "audio/mpeg", "audio/wav", "audio/aiff", "audio/aac", "audio/flac", "audio/ogg"];
    const isSupported = mimeType && supportedFormats.some(format => mimeType.toLowerCase().includes(format.split("/")[1]));
    const needsConversion = mimeType?.includes("webm") || (!isSupported && mimeType);
    
    if (needsConversion) {
      try {
        // Check if ffmpeg is available
        try {
          await execAsync("ffmpeg -version");
        } catch (ffmpegError) {
          console.warn("[Gemini] FFmpeg not found. Audio conversion requires ffmpeg to be installed.");
          console.warn("[Gemini] Attempting to use original format - this may fail if format is not supported by Gemini.");
          // Continue with original format - Gemini might still accept it
        }
        
        console.log(`[Gemini] Converting audio from ${mimeType} to MP3 (Gemini supported format)`);
        finalAudioData = await convertAudioToMP3(audioData, mimeType || "audio/webm");
        finalMimeType = "audio/mp3";
        console.log(`[Gemini] Audio converted successfully: ${finalAudioData.length} bytes`);
      } catch (error) {
        console.error(`[Gemini] Audio conversion failed:`, error);
        console.warn(`[Gemini] Falling back to original format - this may cause transcription to fail`);
        // Keep original data and format - let Gemini API return error if unsupported
        // This way we get a clear error message
      }
    }
    
    console.log(`[Gemini] Transcribing audio chunk: ${finalAudioData.length} bytes, mimeType: ${finalMimeType}`);

    // Enhanced prompt for accurate, continuous transcription
    let promptText = "";
    const baseInstructions = `SYSTEM INSTRUCTION:
- Transcribe EXACT spoken words with punctuation kept natural.
- Never invent or summarize content. If you cannot hear new speech, respond with "[silence]".
- If speech is unclear, respond with "[inaudible]".
- Format every utterance as "[Speaker 1]: words". Use [Speaker 2], [Speaker 3] only when clearly different voices exist.
- Do not repeat previous transcript content. Only emit NEW audio from this chunk.
- Do not describe tones or music unless the speaker explicitly says those words.`;
    
    // Only include context if there's substantial previous speech
    const hasActualSpeech = previousContext && 
      previousContext.trim() && 
      !previousContext.match(/^(\[silence\]|\[inaudible\]|\[unclear\])+$/i) &&
      previousContext.length > 20;
    
    if (hasActualSpeech) {
      // Include context for continuity - very minimal prompt
      // Put context first, then simple instruction
      promptText = `${baseInstructions}

Previous transcript (context only, do NOT repeat):
${previousContext}

Now transcribe the new audio. Continue from above and only include newly spoken words.`;
    } else {
      // First chunk - very minimal prompt
      promptText = `${baseInstructions}

Transcribe this audio now.`;
    }

    // Use gemini-2.5-flash for audio transcription (most reliable)
    // Skip experimental models that may not be available or are rate-limited
    let response;
    let lastError: Error | null = null;
    
    // Use standard model - most reliable and available
    const model = "gemini-2.5-flash";
    const maxRetries = 3;
    const baseRetryDelay = 2000; // 2 seconds base delay
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        response = await ai.models.generateContent({
          model: model,
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    data: finalAudioData,
                    mimeType: finalMimeType,
                  },
                },
                {
                  text: promptText,
                },
              ],
            },
          ],
        });
        console.log(`[Gemini] Successfully transcribed using model: ${model} (attempt ${attempt + 1})`);
        break; // Success
      } catch (error) {
        lastError = error as Error;
        const errorMessage = (error as Error).message || String(error);
        const errorObj = error as any;
        
        // Check if it's a rate limit error with retry delay
        const isRateLimit = 
          errorMessage.includes("429") ||
          errorMessage.includes("rate limit") ||
          errorMessage.includes("quota") ||
          errorMessage.includes("RESOURCE_EXHAUSTED");
        
        // Extract retry delay from error if available
        let retryDelay = baseRetryDelay * Math.pow(2, attempt); // Exponential backoff
        
        if (isRateLimit && errorObj?.error?.details) {
          // Try to extract retry delay from API response
          const retryInfo = errorObj.error.details.find((d: any) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo");
          if (retryInfo?.retryDelay) {
            // Parse delay (format: "58s" or similar)
            const delayMatch = retryInfo.retryDelay.match(/(\d+)/);
            if (delayMatch) {
              retryDelay = parseInt(delayMatch[1]) * 1000; // Convert to milliseconds
              console.warn(`[Gemini] Rate limit hit, waiting ${retryDelay}ms as suggested by API`);
            }
          }
        }
        
        // Check if error is retryable
        const isRetryable = 
          isRateLimit ||
          errorMessage.includes("network") ||
          errorMessage.includes("timeout") ||
          errorMessage.includes("503") ||
          errorMessage.includes("500");
        
        if (isRetryable && attempt < maxRetries - 1) {
          console.warn(`[Gemini] Model ${model} failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${retryDelay}ms:`, errorMessage.substring(0, 200));
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          continue; // Retry
        } else {
          console.error(`[Gemini] Model ${model} failed (attempt ${attempt + 1}/${maxRetries}):`, errorMessage.substring(0, 200));
          if (attempt === maxRetries - 1) {
            // Last attempt failed, throw error
            throw new Error(`Transcription failed after ${maxRetries} attempts: ${errorMessage.substring(0, 200)}`);
          }
        }
      }
    }
    
    if (!response) {
      throw new Error(`Transcription failed. Last error: ${lastError?.message}`);
    }

    let text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
    
    // Remove the prompt text if it appears at the start of the response
    // This happens sometimes when the model echoes the prompt
    if (text) {
      const originalText = text;
      const promptLines = promptText.split('\n').map(l => l.trim()).filter(l => l.length > 5);
      for (const promptLine of promptLines) {
        const lowerPrompt = promptLine.toLowerCase();
        const lowerText = text.toLowerCase();
        // Only remove if it's at the very start and exact match
        if (lowerText.startsWith(lowerPrompt) && text.length > promptLine.length) {
          text = text.substring(promptLine.length).trim();
          // Only log if we actually removed something significant
          if (originalText.length - text.length > 10) {
            console.log(`[Gemini] Removed ${originalText.length - text.length} chars of prompt text from start`);
          }
        }
      }
    }
    
    console.log(`[Gemini] Raw transcription response length: ${text.length}`);
    
    // Clean up common refusal patterns and hallucination patterns
    let cleanedText = text;
    
    // Remove refusal messages (multi-line patterns)
    cleanedText = cleanedText.replace(/I (am sorry|cannot|can't|do not|don't)[\s\S]*?audio[\s\S]*?(?=\n\n|$)/gi, "");
    cleanedText = cleanedText.replace(/as an AI model[\s\S]*?cannot[\s\S]*?audio[\s\S]*?(?=\n\n|$)/gi, "");
    cleanedText = cleanedText.replace(/I cannot directly process audio[\s\S]*?(?=\n\n|$)/gi, "");
    cleanedText = cleanedText.replace(/Please provide the text[\s\S]*?(?=\n\n|$)/gi, "");
    cleanedText = cleanedText.replace(/I'm sorry[\s\S]*?audio[\s\S]*?(?=\n\n|$)/gi, "");
    
    // Remove introductory phrases that models sometimes add
    cleanedText = cleanedText.replace(/^(okay,?\s*)?(here'?s?\s*)?(the\s*)?(transcription|transcript)(\s*with\s*speaker\s*diarization)?:?\s*/i, "");
    cleanedText = cleanedText.replace(/^(here'?s?\s*)?(a\s*)?(transcription|transcript):?\s*/i, "");
    
    // Remove any remaining refusal patterns
    if (cleanedText.toLowerCase().includes("cannot process") || 
        cleanedText.toLowerCase().includes("cannot directly") ||
        cleanedText.toLowerCase().includes("i cannot") ||
        cleanedText.toLowerCase().includes("i'm sorry")) {
      console.warn("[Gemini] AI refused to transcribe. Response:", cleanedText.substring(0, 200));
      // Try to extract any actual transcription that might be in the response
      const transcriptionMatch = cleanedText.match(/(\[Speaker \d+\]:.*|\[inaudible\].*|\[silence\].*|\[unclear\].*)/i);
      if (transcriptionMatch) {
        return transcriptionMatch[0].trim();
      }
      return "[unclear]";
    }
    
    // Remove prompt text that might appear in response (very specific patterns only)
    // Be very conservative - only remove if it's clearly just the prompt with no actual transcription
    const lowerText = cleanedText.toLowerCase();
    const hasSpeakerLabels = cleanedText.includes("[Speaker");
    
    // Only flag as prompt if: has specific prompt phrases AND no speaker labels AND very short
    const isJustPrompt = !hasSpeakerLabels && 
                        cleanedText.length < 100 &&
                        (lowerText.includes("transcribe this audio") || 
                         lowerText.includes("format: [speaker 1]") ||
                         (lowerText.includes("previous transcript") && !lowerText.includes("speaker")));
    
    if (isJustPrompt) {
      console.warn("[Gemini] Response appears to be only prompt text, no transcription. Returning silence.");
      return "[silence]";
    }
    
    // If response has speaker labels, it's valid transcription - don't filter
    if (hasSpeakerLabels) {
      // Valid transcription - keep as is
      // Just remove any prompt text that might be at the start
      const lines = cleanedText.split('\n');
      const filteredLines = lines.filter(line => {
        const lowerLine = line.toLowerCase().trim();
        // Remove lines that are clearly just prompt instructions (not speech)
        return !(lowerLine.startsWith("previous transcript:") ||
                 lowerLine.startsWith("now transcribe") ||
                 lowerLine.startsWith("continue from") ||
                 (lowerLine.includes("format:") && !lowerLine.includes("[Speaker")));
      });
      cleanedText = filteredLines.join('\n');
    }
    
    // Check for suspicious multi-speaker patterns in short chunks
    const allLinesForCheck = cleanedText.split('\n');
    const filteredLines = allLinesForCheck.filter(line => {
      const trimmedLine = line.trim();
      if (!trimmedLine) return false;
      
      // Check for multiple speakers in a single line (suspicious)
      const speakerMatches = trimmedLine.match(/\[Speaker \d+\]:/g);
      if (speakerMatches && speakerMatches.length > 1) {
        console.warn(`[Gemini] Multiple speakers in single line - suspicious, removing: ${trimmedLine.substring(0, 80)}`);
        return false;
      }
      
      return true;
    });
    
    cleanedText = filteredLines.join('\n');
    
    // Smart repetition detection - only remove if it's clearly a hallucination
    // Check for exact duplicate lines (same line appearing multiple times consecutively)
    const textLinesForDedup = cleanedText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const deduplicatedLines: string[] = [];
    let lastLine = "";
    let consecutiveDuplicates = 0;
    
    for (let i = 0; i < textLinesForDedup.length; i++) {
      const currentLine = textLinesForDedup[i];
      const normalizedLine = currentLine.toLowerCase();
      
      // Check if this line is exactly the same as the previous line
      if (normalizedLine === lastLine.toLowerCase() && normalizedLine.length > 15) {
        consecutiveDuplicates++;
        // Only keep first occurrence if we see 2+ consecutive duplicates
        if (consecutiveDuplicates >= 2) {
          console.warn(`[Gemini] Removing consecutive duplicate line (${consecutiveDuplicates + 1} times): ${currentLine.substring(0, 60)}`);
          continue; // Skip this duplicate
        }
      } else {
        consecutiveDuplicates = 0; // Reset counter
      }
      
      deduplicatedLines.push(currentLine);
      lastLine = currentLine;
    }
    
    cleanedText = deduplicatedLines.join('\n');
    
    // Also check for phrase repetition within the same chunk (but be less aggressive)
    // Only flag if the same 5+ word phrase appears 3+ times in a single chunk
    const allText = cleanedText.toLowerCase();
    const words = allText.split(/\s+/).filter(w => w.length > 2);
    
    if (words.length > 15) {
      // Check for 5-word phrase repetition (more specific, less false positives)
      const phraseCounts = new Map<string, number>();
      for (let i = 0; i < words.length - 4; i++) {
        const phrase = words.slice(i, i + 5).join(' '); // 5-word phrases
        phraseCounts.set(phrase, (phraseCounts.get(phrase) || 0) + 1);
      }
      
      // Only remove if a phrase appears 4+ times (very suspicious)
      for (const [phrase, count] of phraseCounts.entries()) {
        if (count >= 4) {
          console.warn(`[Gemini] Detected highly repetitive phrase "${phrase}" ${count} times - likely hallucination`);
          // Remove all but first occurrence
          const phraseLines = cleanedText.split('\n');
          let foundFirst = false;
          const filteredPhraseLines = phraseLines.filter(line => {
            const lowerLine = line.toLowerCase();
            if (lowerLine.includes(phrase)) {
              if (!foundFirst) {
                foundFirst = true;
                return true;
              }
              return false;
            }
            return true;
          });
          cleanedText = filteredPhraseLines.join('\n');
          break;
        }
      }
    }

    const nonVerbalOnly = cleanedText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .every(line => /\[Speaker \d+\]:\s*\[[^\]]+\]/i.test(line));

    if (nonVerbalOnly && cleanedText.length < 200) {
      console.warn("[Gemini] Response only contains non-verbal descriptions. Treating as silence.");
      return "[silence]";
    }
    
    // Final validation: check speaker count for logging
    const speakerCount = (cleanedText.match(/\[Speaker \d+\]:/g) || []).length;
    
    // If the cleaned text is empty, return a placeholder
    if (!cleanedText.trim()) {
      console.warn("[Gemini] Empty transcription result. Audio may be silent or unclear.");
      return "[silence]";
    }
    
    // If response is very long (>300 chars) but audio was small, might be hallucination
    // This is a heuristic - we'll be conservative
    if (cleanedText.length > 300 && audioData.length < 50000) {
      console.warn(`[Gemini] Suspicious: Long response (${cleanedText.length} chars) from small audio (${audioData.length} bytes)`);
      // Don't reject, but log for monitoring
    }
    
    return cleanedText.trim();
  } catch (error) {
    console.error("Error transcribing audio:", error);
    throw new Error("Failed to transcribe audio");
  }
}

/**
 * Generates a summary of the meeting transcript
 * @param transcript - Full transcript text
 * @returns Summary with key points, action items, and decisions
 */
export async function generateSummary(transcript: string): Promise<string> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          parts: [
            {
              text: `You are a meeting assistant that creates natural, conversational summaries. Read the transcript below and create a clear, flowing summary that captures the essence of the conversation.

GUIDELINES:
- Write in a natural, readable style - like you're explaining the meeting to a colleague
- Focus on what was actually discussed - be factual but make it flow naturally
- Group related topics together logically
- Use clear, concise language
- If something isn't mentioned, simply omit it - don't say "not mentioned"
- The transcript may have speaker labels like [Speaker 1]: - use these to understand the conversation flow
- ONLY include information that is explicitly stated in the transcript
- DO NOT add, infer, or invent information that isn't in the transcript

Create a summary in this format:

## Meeting Summary

[Write 2-3 paragraphs that naturally summarize the main discussion points, topics covered, and key information shared. Make it read like a narrative, not a bullet list. Only include what's actually in the transcript.]

## Key Takeaways

[If there are clear action items, decisions, or next steps mentioned, list them here in a natural way. If none are mentioned, omit this section entirely.]

## Discussion Highlights

[If there were interesting points, insights, or important details discussed, mention them here naturally. If the conversation was straightforward, you can omit this section.]

Remember: Write naturally and conversationally. Only include what's actually in the transcript. Make it easy to read and understand. DO NOT make up information.

Transcript:
${transcript}`,
            },
          ],
        },
      ],
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
    
    // Post-process to remove common hallucination patterns
    let cleanedText = text;
    
    // Remove phrases that suggest the AI is making things up
    cleanedText = cleanedText.replace(/based on (the )?provided transcript/gi, "");
    cleanedText = cleanedText.replace(/here'?s (the )?summary/gi, "");
    cleanedText = cleanedText.replace(/here'?s (a )?summary/gi, "");
    cleanedText = cleanedText.replace(/summary (of|based on)/gi, "Summary");
    
    // Remove specific hallucination patterns (like audiobook mentions)
    const hallucinationPatterns = [
      /thanked the listener for purchasing an audiobook/gi,
      /enjoy their story/gi,
      /enjoy your story/gi,
      /audiobook/gi,
      /Thank you for listening/gi,
      /Thank you for purchasing/gi,
    ];
    
    hallucinationPatterns.forEach(pattern => {
      cleanedText = cleanedText.replace(pattern, "");
    });
    
    // If summary contains phrases that aren't in the transcript, remove those lines
    if (cleanedText.toLowerCase().includes("thanked") && !transcript.toLowerCase().includes("thank")) {
      console.warn("[Gemini] Summary contains 'thanked' but transcript doesn't - removing suspicious content");
      const lines = cleanedText.split('\n');
      const filteredLines = lines.filter(line => {
        const lowerLine = line.toLowerCase();
        return !lowerLine.includes("thanked") && 
               !lowerLine.includes("audiobook") && 
               !lowerLine.includes("listener") &&
               !lowerLine.includes("enjoy your story") &&
               !lowerLine.includes("enjoy their story");
      });
      cleanedText = filteredLines.join('\n');
    }
    
    // If summary is too generic or seems made up, make it more conservative
    if (cleanedText.toLowerCase().includes("key objectives") && !transcript.toLowerCase().includes("key objectives")) {
      // The AI might be inferring - be more conservative
      cleanedText = cleanedText.replace(/key objectives[^.]*/gi, "Topics mentioned in the transcript");
    }
    
    return cleanedText.trim() || "Summary could not be generated from the transcript.";
  } catch (error) {
    console.error("Error generating summary:", error);
    throw new Error("Failed to generate summary");
  }
}

