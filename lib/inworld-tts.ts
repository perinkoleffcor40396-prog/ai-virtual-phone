// lib/inworld-tts.ts — Inworld AI TTS provider helper

import type { VoiceApiConfig } from "./settings-types";

const DEFAULT_INWORLD_BASE_URL = "https://api.inworld.ai";
const DEFAULT_INWORLD_MODEL = "inworld-tts-2-flash";

function decodeBase64Audio(audioContent: string): Uint8Array {
    const binary = atob(audioContent);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/** Synthesize speech with an Inworld cloned/built-in voice. */
export async function synthesizeInworld(
    text: string,
    config: VoiceApiConfig,
    timeoutMs = 120_000,
): Promise<Blob> {
    if (!config.apiKey?.trim()) throw new Error("Inworld API Key 未配置");
    if (!config.defaultVoice?.trim()) throw new Error("Inworld Voice ID 未配置");

    const baseUrl = (config.baseUrl || DEFAULT_INWORLD_BASE_URL).replace(/\/$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(`${baseUrl}/tts/v1/voice`, {
            method: "POST",
            signal: controller.signal,
            headers: {
                Authorization: `Basic ${config.apiKey.trim()}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                text,
                voiceId: config.defaultVoice.trim(),
                modelId: config.model || DEFAULT_INWORLD_MODEL,
                audioConfig: { audioEncoding: "MP3", sampleRateHertz: 24000 },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            throw new Error(`Inworld TTS 请求失败 (${response.status}): ${errorText.slice(0, 500)}`);
        }

        const data = await response.json() as { audioContent?: string };
        if (!data.audioContent) throw new Error("Inworld 未返回 audioContent 音频数据");

        return new Blob([decodeBase64Audio(data.audioContent)], { type: "audio/mpeg" });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            throw new Error(`Inworld 语音合成超时（超过 ${Math.round(timeoutMs / 1000)} 秒无响应）`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

export const INWORLD_TTS_MODELS = [
    { id: "inworld-tts-2-flash", name: "Inworld TTS-2 Flash（低延迟，推荐聊天）" },
    { id: "inworld-tts-2", name: "Inworld TTS-2（高品质）" },
] as const;

export const DEFAULT_INWORLD_TTS_MODEL = DEFAULT_INWORLD_MODEL;
export const INWORLD_TTS_BASE_URL = DEFAULT_INWORLD_BASE_URL;
