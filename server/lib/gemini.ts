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
 * @returns Transcribed text with speaker diarization if available
 */
export async function transcribeAudio(
  audioData: string,
  mimeType: string = "audio/webm"
): Promise<string> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          parts: [
            {
              text: `You are a strict audio transcription system. Your ONLY job is to transcribe EXACTLY what you hear in the audio - nothing more, nothing less.

CRITICAL RULES - FOLLOW THESE EXACTLY:
1. Transcribe ONLY the actual spoken words you hear in the audio
2. If you cannot clearly hear something, write "[inaudible]" - DO NOT guess or make up words
3. If there is silence, write "[silence]" - DO NOT invent content during silence
4. DO NOT add any context, explanations, or interpretations
5. DO NOT continue conversations that aren't in the audio
6. DO NOT make up topics, names, or details that aren't spoken
7. DO NOT infer what someone "probably" said - only write what you actually hear
8. If audio quality is poor and words are unclear, write "[unclear]" - DO NOT guess
9. Use speaker labels ONLY if you can clearly distinguish different voices: [Speaker 1]: text
10. If you cannot distinguish speakers, use [Speaker 1] for all speech
11. DO NOT include phrases like "Here's the transcription" or any introductory text
12. DO NOT add punctuation or formatting that isn't indicated by speech patterns
13. If the audio contains background noise or music without speech, write "[background noise]" or "[music]"
14. DO NOT transcribe background conversations or off-topic speech unless it's the main audio

Remember: When in doubt, write "[inaudible]" or "[unclear]" - NEVER invent content.

Transcribe this audio chunk now:`,
            },
            {
              inlineData: {
                data: audioData,
                mimeType: mimeType,
              },
            },
          ],
        },
      ],
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
    
    // Clean up common hallucination patterns
    let cleanedText = text || "";
    
    // Remove introductory phrases that models sometimes add
    cleanedText = cleanedText.replace(/^(okay,?\s*)?(here'?s?\s*)?(the\s*)?(transcription|transcript)(\s*with\s*speaker\s*diarization)?:?\s*/i, "");
    cleanedText = cleanedText.replace(/^(here'?s?\s*)?(a\s*)?(transcription|transcript):?\s*/i, "");
    
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
              text: `You are a strict meeting summarization assistant. Your ONLY job is to summarize EXACTLY what is written in the transcript below - nothing more, nothing less.

ABSOLUTE RULES - FOLLOW THESE EXACTLY:
1. ONLY summarize information that is EXPLICITLY written in the transcript text below
2. If the transcript contains "[inaudible]", "[unclear]", "[silence]", or "[background noise]" - DO NOT make up what was said
3. If the transcript is mostly unclear/inaudible, say "Transcript quality was poor - most content was inaudible"
4. DO NOT infer, guess, or add ANY information that is not directly stated in the transcript
5. DO NOT make up action items, decisions, owners, or next steps - if they're not explicitly mentioned, say "None mentioned"
6. DO NOT add context or explanations that aren't in the transcript
7. DO NOT continue conversations or topics that aren't in the transcript
8. If the transcript is very short or mostly unclear, your summary should reflect that - DO NOT expand on it
9. Be extremely literal - if someone says "attack capital assignment", summarize it as "attack capital assignment" - DO NOT expand it into a full description unless that description is in the transcript
10. If the transcript shows someone was working on something but doesn't say what they achieved, DO NOT make up achievements

Create a summary with these sections (be extremely literal):
1. Key Points Discussed - List ONLY topics that are explicitly mentioned in the transcript. If the transcript is unclear, say "Transcript was unclear - specific topics could not be identified"
2. Action Items with Owners - List ONLY action items that are explicitly stated with owners. If none are mentioned, say "None mentioned"
3. Decisions Made - List ONLY decisions that are explicitly stated. If none are mentioned, say "No explicit decisions were made"
4. Important Next Steps - List ONLY next steps that are explicitly mentioned. If none are mentioned, say "No next steps were outlined"

Remember: When in doubt, say "Not mentioned" or "Unclear from transcript" - NEVER invent content.

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

