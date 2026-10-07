import { Readable } from "stream";
import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { INWORLD_BASIC } from "../../config.js";
import { DEFAULT_VOICES, getDefaultModels, TYPES } from "../config.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
const INWORLD_TTS_URL = "https://api.inworld.ai/tts/v1/voice:stream";
function getApiKey() {
    if (!INWORLD_BASIC) {
        throw new ProviderError("inworld", "INWORLD_BASIC is not set", 401);
    }
    return INWORLD_BASIC;
}
/**
 * Parse Inworld's NDJSON stream and yield decoded results.
 * Each line is a JSON object with `result.audioContent` (base64) and
 * optionally `result.timestampInfo`.
 */
async function* parseNdjsonStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const chunk = JSON.parse(line);
                    if (chunk.result) {
                        yield chunk.result;
                    }
                }
                catch (error) {
                    logger.warn(`[Inworld] NDJSON parse error: ${getErrorMessage(error)}`);
                }
            }
        }
    }
    finally {
        reader.releaseLock();
    }
}
const inworldProvider = {
    name: "inworld",
    /**
     * Generate speech via Inworld TTS (MP3).
     * Returns a Node Readable stream suitable for piping to an HTTP response.
     */
    async generateSpeech(text, voice = DEFAULT_VOICES.inworld, options = {}) {
        logger.provider("Inworld", `generateSpeech voice=${voice}`);
        try {
            const apiKey = getApiKey();
            const model = options.model || getDefaultModels(TYPES.TEXT, TYPES.AUDIO).inworld;
            const isTtsTwo = model.startsWith("inworld-tts-2");
            const response = await fetch(INWORLD_TTS_URL, {
                method: "POST",
                headers: {
                    Authorization: `Basic ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    text,
                    voice_id: voice,
                    audio_config: {
                        audio_encoding: "MP3",
                        sample_rate_hertz: 24000,
                    },
                    ...(isTtsTwo
                        ? { delivery_mode: options.deliveryMode ?? "CREATIVE" }
                        : { temperature: options.temperature ?? 1.1 }),
                    model_id: model,
                }),
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Inworld TTS API error: ${response.status} ${errorText}`);
            }
            // Collect base64 audio chunks from the NDJSON stream into a Node Readable
            async function* audioChunks() {
                for await (const result of parseNdjsonStream(response.body)) {
                    if (result.audioContent) {
                        yield Buffer.from(result.audioContent, "base64");
                    }
                }
            }
            const stream = Readable.from(audioChunks());
            return { stream, contentType: "audio/mpeg" };
        }
        catch (error) {
            if (error instanceof ProviderError)
                throw error;
            throw new ProviderError("inworld", getErrorMessage(error), 500, error);
        }
    },
    /**
     * Stream speech via Inworld TTS (PCM LINEAR16 + word timestamps).
     * Accepts an async text iterator (same interface as ElevenLabs) and
     * yields raw audio Buffer chunks.
     *
  
  
     * @yields {Buffer} PCM audio chunks.
     */
    async *generateSpeechStream(textStream, voice = DEFAULT_VOICES.inworld, options = {}) {
        logger.provider("Inworld", `generateSpeechStream voice=${voice}`);
        const apiKey = getApiKey();
        const model = options.model || getDefaultModels(TYPES.TEXT, TYPES.AUDIO).inworld;
        // Accumulate all text from the async iterator first, since
        // Inworld's API is request-level streaming (not input-level).
        let fullText = "";
        for await (const chunk of textStream) {
            fullText += chunk;
        }
        if (!fullText.trim()) {
            return;
        }
        const controller = new AbortController();
        try {
            const isTtsTwo = model.startsWith("inworld-tts-2");
            const response = await fetch(INWORLD_TTS_URL, {
                method: "POST",
                headers: {
                    Authorization: `Basic ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    text: fullText,
                    voice_id: voice,
                    audio_config: {
                        audio_encoding: "LINEAR16",
                        sample_rate_hertz: 24000,
                    },
                    ...(isTtsTwo
                        ? { delivery_mode: options.deliveryMode ?? "CREATIVE" }
                        : { temperature: options.temperature ?? 1.1 }),
                    model_id: model,
                    timestampType: "WORD",
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Inworld TTS API error: ${response.status} ${errorText}`);
            }
            for await (const result of parseNdjsonStream(response.body)) {
                if (result.audioContent) {
                    yield Buffer.from(result.audioContent, "base64");
                }
            }
        }
        catch (error) {
            if (error instanceof Error && error.name === "AbortError")
                return;
            if (error instanceof ProviderError)
                throw error;
            throw new ProviderError("inworld", getErrorMessage(error), 500, error);
        }
        finally {
            controller.abort();
        }
    },
};
export default inworldProvider;
//# sourceMappingURL=inworld.js.map