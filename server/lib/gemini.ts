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
              text: `You are a precise audio transcription system. Your task is to transcribe ONLY what you actually hear in the audio. 

IMPORTANT RULES:
- Transcribe EXACTLY what is spoken, word for word
- Do NOT add, invent, or infer any content that is not clearly audible
- Do NOT make up conversations or topics that are not in the audio
- If audio is unclear or silent, say "inaudible" or "silence" - do NOT invent content
- Use speaker diarization when you can clearly distinguish different speakers
- Format as: [Speaker 1]: transcribed text
- If you cannot identify distinct speakers, use [Speaker 1] for all speech
- Do NOT include any introductory text like "Here's the transcription" or "Okay, here's..."

Transcribe this audio now:`,
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
              text: `You are a meeting summarization assistant. Your task is to create an accurate summary based ONLY on the information provided in the transcript below.

CRITICAL RULES:
- ONLY include information that is explicitly stated in the transcript
- Do NOT invent, infer, or add any information that is not in the transcript
- Do NOT make up action items, decisions, or next steps that are not mentioned
- If something is not mentioned, explicitly state "Not mentioned" or "None" rather than making it up
- Be precise and factual - stick to what was actually discussed
- If the transcript is about technical topics, accurately reflect those topics
- If the transcript is about business topics, accurately reflect those topics
- Do NOT confuse or mix up different topics or conversations

Create a summary with these sections:
1. Key Points Discussed - List only the main topics that were explicitly discussed
2. Action Items with Owners - List only action items that were explicitly mentioned with owners (if none, say "None mentioned")
3. Decisions Made - List only decisions that were explicitly stated (if none, say "No explicit decisions were made")
4. Important Next Steps - List only next steps that were explicitly mentioned (if none, say "No next steps were outlined")

Transcript:
${transcript}`,
            },
          ],
        },
      ],
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
    return text || "";
  } catch (error) {
    console.error("Error generating summary:", error);
    throw new Error("Failed to generate summary");
  }
}

