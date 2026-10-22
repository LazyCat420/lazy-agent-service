import { ProviderOptions } from "../types/ProviderTypes.ts";
import WebSocket from "ws";
import { ProviderError } from "../utils/errors.ts";
import logger from "../utils/logger.ts";
import { ELEVENLABS_API_KEY } from "../../config.ts";
import { TYPES, DEFAULT_VOICES, getDefaultModels } from "../config.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

function getApiKey() {
  if (!ELEVENLABS_API_KEY) {
    throw new ProviderError("elevenlabs", "ELEVENLABS_API_KEY is not set", 401);
  }
  return ELEVENLABS_API_KEY;
}

const elevenlabsProvider = {
  name: "elevenlabs",

  async generateSpeech(
    text: string,
    voiceId: string = DEFAULT_VOICES.elevenlabs,
    options: ProviderOptions = {},
  ) {
    logger.provider("ElevenLabs", `generateSpeech voiceId=${voiceId}`);
    try {
      const apiKey = getApiKey();
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
        {
          method: "POST",
          headers: {
            Accept: "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": apiKey,
          },
          body: JSON.stringify({
            text,
            model_id:
              options.modelId ||
              getDefaultModels(TYPES.TEXT, TYPES.AUDIO).elevenlabs,
            voice_settings: {
              stability: options.stability || 0.5,
              similarity_boost: options.similarityBoost || 0.8,
            },
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `ElevenLabs API error: ${response.status} ${errorText}`,
        );
      }

      return { stream: response.body, contentType: "audio/mpeg" };
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("elevenlabs", getErrorMessage(error), 500, error);
    }
  },
  async *generateSpeechStream(
    textStream: AsyncIterable<string>,
    voiceId: string = DEFAULT_VOICES.elevenlabs,
    options: ProviderOptions = {},
  ) {
    logger.provider("ElevenLabs", `generateSpeechStream voiceId=${voiceId}`);
    const apiKey = getApiKey();
    const modelId =
      options.modelId || getDefaultModels(TYPES.TEXT, TYPES.AUDIO).elevenlabs;
    const websocketUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}`;

    const websocket = new WebSocket(websocketUrl, {
      headers: { "xi-api-key": apiKey },
    });

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      websocket.on("open", resolve);
      websocket.on("error", reject);
    });

    // Send initial config
    websocket.send(
      JSON.stringify({
        text: " ",
        voice_settings: {
          stability: options.stability || 0.5,
          similarity_boost: options.similarityBoost || 0.8,
        },
        xi_api_key: apiKey,
      }),
    );

    // Message queue for yielding in order
    const messageQueue: { audio?: string; isFinal?: boolean }[] = [];
    let resolveMessage: (() => void) | null = null;
    let ended = false;
    let error: Error | null = null;

    websocket.on("message", (data: WebSocket.RawData) => {
      const response = JSON.parse(data.toString());
      messageQueue.push(response);
      if (resolveMessage) {
        const resolve = resolveMessage;
        resolveMessage = null;
        resolve();
      }
    });

    websocket.on("close", () => {
      ended = true;
      if (resolveMessage) resolveMessage();
    });

    websocket.on("error", (websocketError: Error) => {
      error = websocketError;
      if (resolveMessage) resolveMessage();
    });

    // Send text in background
    (async () => {
      try {
        let buffer = "";
        for await (const chunk of textStream) {
          buffer += chunk;
          let match: RegExpMatchArray | null;
          while ((match = buffer.match(/([.!?]+)\s/))) {
            const cutIndex = match.index! + match[0].length;
            const sentence = buffer.slice(0, cutIndex);
            buffer = buffer.slice(cutIndex);
            if (websocket.readyState === WebSocket.OPEN) {
              websocket.send(
                JSON.stringify({
                  text: sentence,
                  try_trigger_generation: true,
                }),
              );
            }
          }
        }

        // Flush remaining
        if (buffer.length > 0 && websocket.readyState === WebSocket.OPEN) {
          websocket.send(
            JSON.stringify({ text: buffer, try_trigger_generation: true }),
          );
        }

        // Send EOS
        if (websocket.readyState === WebSocket.OPEN) {
          websocket.send(JSON.stringify({ text: "" }));
        }
      } catch (error: unknown) {
        logger.error("Error sending to ElevenLabs WS:", error);
        websocket.close();
      }
    })();

    // Yield audio chunks
    try {
      while (true) {
        if (messageQueue.length > 0) {
          const message = messageQueue.shift()!;
          if (message.audio) {
            yield Buffer.from(message.audio, "base64");
          }
          if (message.isFinal) {
            break;
          }
        } else {
          if (error)
            throw new ProviderError(
              "elevenlabs",
              getErrorMessage(error),
              500,
              error,
            );
          if (ended) break;
          await new Promise<void>((resolve) => {
            resolveMessage = resolve;
          });
        }
      }
    } finally {
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.close();
      }
    }
  },
};

export default elevenlabsProvider;
