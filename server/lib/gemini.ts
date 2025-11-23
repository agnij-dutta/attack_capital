import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

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

    // Ensure mimeType is valid
    const validMimeType = mimeType || "audio/webm";
    
    console.log(`[Gemini] Transcribing audio chunk: ${audioData.length} bytes, mimeType: ${validMimeType}`);

    // Ultra-simple, direct prompt for maximum accuracy
    // Put audio FIRST, then minimal instruction
    let promptText = "";
    
    // Only include context if there's substantial previous speech
    const hasActualSpeech = previousContext && 
      previousContext.trim() && 
      !previousContext.match(/^(\[silence\]|\[inaudible\]|\[unclear\])+$/i) &&
      previousContext.length > 20;
    
    if (hasActualSpeech) {
      // Include context but keep prompt minimal
      promptText = `Previous: ${previousContext.substring(0, 200)}...\n\nTranscribe the audio. Format: [Speaker 1]: text. Use [silence] if no speech, [inaudible] if unclear.`;
    } else {
      // Minimal prompt - just the essentials
      promptText = `Transcribe the audio. Format: [Speaker 1]: text. Use [silence] if no speech, [inaudible] if unclear.`;
    }

    // Put audio FIRST, then prompt - this helps the model focus on audio
    // Try gemini-2.0-flash-exp first (better for audio), fallback to 2.5-flash
    let response;
    try {
      response = await ai.models.generateContent({
        model: "gemini-2.0-flash-exp",
        contents: [
          {
            parts: [
              {
                inlineData: {
                  data: audioData,
                  mimeType: validMimeType,
                },
              },
              {
                text: promptText,
              },
            ],
          },
        ],
      });
    } catch (error) {
      // Fallback to standard model if experimental fails
      console.warn("[Gemini] Experimental model failed, using standard model:", error);
      response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            parts: [
              {
                inlineData: {
                  data: audioData,
                  mimeType: validMimeType,
                },
              },
              {
                text: promptText,
              },
            ],
          },
        ],
      });
    }

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
    
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
    
    // Remove any hallucinated content patterns (like reading the prompt back or making up conversations)
    if (cleanedText.toLowerCase().includes("transcribe") && 
        (cleanedText.toLowerCase().includes("audio") || cleanedText.toLowerCase().includes("spoken words"))) {
      console.warn("[Gemini] AI may have transcribed the prompt instead of audio. Removing prompt text.");
      // Remove lines that contain prompt text
      const lines = cleanedText.split('\n');
      const filteredLines = lines.filter(line => {
        const lowerLine = line.toLowerCase();
        return !lowerLine.includes("transcribe") &&
               !lowerLine.includes("output only") &&
               !lowerLine.includes("format:") &&
               !lowerLine.includes("use inaudible") &&
               !lowerLine.includes("spoken words");
      });
      cleanedText = filteredLines.join('\n');
    }
    
    // AGGRESSIVE hallucination detection - common business/meeting phrases that indicate AI is making things up
    const businessHallucinationPatterns = [
      /budget|Q[1-4]|quarter|fiscal|profitability|ROI|revenue|expenses/gi,
      /marketing\s+spend|advertising|campaigns|digital\s+campaigns/gi,
      /revised\s+budget|preliminary|optimized|reallocated/gi,
      /projected\s+impact|marginal\s+improvement|better\s+ROI/gi,
      /traditional\s+advertising|shift\s+towards\s+digital/gi,
      /higher\s+returns|better\s+returns/gi,
    ];
    
    // Check if response contains business jargon (strong indicator of hallucination)
    const hasBusinessJargon = businessHallucinationPatterns.some(pattern => pattern.test(cleanedText));
    
    // Also check for generic meeting phrases
    const genericMeetingPatterns = [
      /okay,?\s+let'?s\s+get\s+started/gi,
      /sounds\s+good\s+to\s+me/gi,
      /first\s+on\s+the\s+agenda/gi,
      /sorry,?\s+i\s+was\s+on\s+mute/gi,
      /no\s+problem/gi,
      /as\s+i\s+was\s+saying/gi,
      /can\s+you\s+repeat\s+that/gi,
      /what\s+do\s+you\s+think/gi,
      /that'?s\s+a\s+good\s+point/gi,
      /let'?s\s+move\s+on/gi,
      /just\s+to\s+clarify/gi,
      /we'?re\s+looking\s+at/gi,
      /that'?s\s+right/gi,
      /we\s+anticipate|we\s+expect/gi,
    ];
    
    const containsGenericPhrases = genericMeetingPatterns.some(pattern => pattern.test(cleanedText));
    
    // If response contains business jargon or generic phrases, it's likely a hallucination
    if (hasBusinessJargon || containsGenericPhrases) {
      console.warn(`[Gemini] Detected hallucination patterns in response. Original: ${cleanedText.substring(0, 200)}`);
      
      // Check if there are multiple speakers - if so, definitely hallucination
      const speakerCount = (cleanedText.match(/\[Speaker \d+\]:/g) || []).length;
      if (speakerCount > 1) {
        console.warn(`[Gemini] Multiple speakers detected with business jargon - rejecting as hallucination`);
        return "[silence]";
      }
      
      // If response is long and contains business terms, reject it
      if (cleanedText.length > 100 && hasBusinessJargon) {
        console.warn(`[Gemini] Long response with business jargon - rejecting as hallucination`);
        return "[silence]";
      }
      
      // Remove lines containing business jargon
      const lines = cleanedText.split('\n');
      const filteredLines = lines.filter(line => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return false;
        
        // Check for business jargon in this line
        const lineHasBusinessJargon = businessHallucinationPatterns.some(pattern => pattern.test(trimmedLine));
        const lineHasGenericPhrase = genericMeetingPatterns.some(pattern => pattern.test(trimmedLine));
        
        if (lineHasBusinessJargon || lineHasGenericPhrase) {
          console.warn(`[Gemini] Removing hallucinated line: ${trimmedLine.substring(0, 80)}`);
          return false;
        }
        
        return true;
      });
      
      cleanedText = filteredLines.join('\n');
      
      // If nothing left after filtering, return silence
      if (!cleanedText.trim() || cleanedText.trim() === "[silence]") {
        return "[silence]";
      }
    }
    
    // Check for suspicious multi-speaker patterns in short chunks
    const lines = cleanedText.split('\n');
    const filteredLines = lines.filter(line => {
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
    
    // Final validation: if response is suspiciously long with multiple speakers, it's likely hallucinated
    const speakerCount = (cleanedText.match(/\[Speaker \d+\]:/g) || []).length;
    if (speakerCount > 1 && cleanedText.length > 150) {
      // Multiple speakers in a long response is suspicious - check if it contains business jargon
      if (hasBusinessJargon) {
        console.warn(`[Gemini] Rejecting long multi-speaker response with business jargon as hallucination`);
        return "[silence]";
      }
    }
    
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

