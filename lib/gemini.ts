import { GoogleGenAI } from "@google/genai";

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
              text: "Transcribe this audio with speaker diarization. Identify different speakers when possible and format as: [Speaker 1]: text",
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
    return text || "";
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
              text: `Summarize this meeting transcript. Include:
1. Key points discussed
2. Action items with owners (if mentioned)
3. Decisions made
4. Important next steps

Format the summary clearly with sections.

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

