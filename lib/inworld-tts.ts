// lib/inworld-tts.ts — Inworld AI TTS provider helper

import type { VoiceApiConfig } from "./settings-types";

export const DEFAULT_INWORLD_BASE_URL = "https://api.inworld.ai";
const DEFAULT_INWORLD_MODEL = "inworld-tts-2-flash";
const STEERABLE_INWORLD_MODEL = "inworld-tts-2";

type VocalState = "neutral" | "amused" | "sarcastic" | "embarrassed" | "annoyed" | "angry" | "sad" | "excited" | "affectionate" | "surprised";

const MJ_VOCAL_STEERING: Record<VocalState, string> = {
    neutral: "speak naturally and conversationally, understated and relaxed, with dry wit and restrained emotion",
    amused: "speak with subtle amusement and a small smile in the voice, lightly playful but understated",
    sarcastic: "speak with dry deadpan sarcasm, controlled and slightly playful, without overacting",
    embarrassed: "speak with quiet embarrassment, slightly softer and a little hesitant, restrained rather than theatrical",
    annoyed: "speak with controlled annoyance, clipped phrasing and slightly firmer delivery, without shouting",
    angry: "speak with contained anger, firm and tense but controlled, as if trying not to lose your temper",
    sad: "speak with quiet sadness, slightly slower, softer and subdued, natural rather than tearful",
    excited: "speak with genuine excitement, more energetic and lively while remaining conversational and believable",
    affectionate: "speak warmly and gently, subtly softer and more intimate, never sugary or overly romantic",
    surprised: "speak with brief natural surprise, slightly brighter and quicker at the onset, without exaggerated acting",
};

function decodeBase64Audio(audioContent: string): Uint8Array {
    const binary = atob(audioContent);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function normalizeVocalState(value?: string): VocalState {
    const state = value?.trim().toLowerCase();
    const aliases: Record<string, VocalState> = {
        neutral: "neutral",
        calm: "neutral",
        happy: "amused",
        amused: "amused",
        playful: "amused",
        sarcastic: "sarcastic",
        sarcasm: "sarcastic",
        embarrassed: "embarrassed",
        embarrassment: "embarrassed",
        shy: "embarrassed",
        annoyed: "annoyed",
        frustrated: "annoyed",
        angry: "angry",
        rage: "angry",
        sad: "sad",
        sorrowful: "sad",
        excited: "excited",
        enthusiastic: "excited",
        affectionate: "affectionate",
        loving: "affectionate",
        surprised: "surprised",
        surprise: "surprised",
    };
    return aliases[state || ""] || "neutral";
}

/**
 * Detect a lightweight vocal state without another LLM call.
 * This is intentionally conservative: most lines remain neutral.
 */
function detectVocalState(text: string): VocalState {
    const t = text.toLowerCase();
    if (/[!！]{2,}|\b(omg|wow|no way|seriously)\b/i.test(t)) return "surprised";
    if (/\b(lol|lmao|haha|hehe|funny|kidding|joking)\b|哈哈|笑死|好笑/.test(t)) return "amused";
    if (/\b(yeah, right|sure, whatever|great job|obviously)\b|呵呵|行啊|真棒/.test(t)) return "sarcastic";
    if (/\b(sorry|embarrass|awkward|shy)\b|抱歉|尷尬|害羞/.test(t)) return "embarrassed";
    if (/\b(ugh|annoying|seriously\?|whatever)\b|煩死|無語|煩人/.test(t)) return "annoyed";
    if (/\b(hate|furious|pissed|angry)\b|氣死|憤怒|生氣/.test(t)) return "angry";
    if (/\b(sad|miss you|missed|sorry to hear)\b|難過|想你|傷心/.test(t)) return "sad";
    if (/\b(excited|can't wait|amazing|awesome)\b|期待|太棒|超級開心/.test(t)) return "excited";
    if (/\b(love you|love ya|dear|sweetheart)\b|愛你|親愛的/.test(t)) return "affectionate";
    return "neutral";
}

function isMjVoiceConfig(config: VoiceApiConfig): boolean {
    const identity = `${config.name || ""} ${config.defaultVoice || ""}`.toLowerCase();
    return /michelle|mj\b/.test(identity);
}

/**
 * Synthesize speech with an Inworld cloned/built-in voice.
 *
 * MJ uses Inworld TTS-2 rather than TTS-2 Flash because natural-language
 * steering is supported by TTS-2. Steering instructions are English and are
 * placed at the start of the text; Inworld interprets them as delivery
 * instructions rather than spoken words.
 */
export async function synthesizeInworld(
    text: string,
    config: VoiceApiConfig,
    options?: { emotion?: string },
    timeoutMs = 120_000,
): Promise<Blob> {
    if (!config.apiKey?.trim()) throw new Error("Inworld API Key 未配置");
    if (!config.defaultVoice?.trim()) throw new Error("Inworld Voice ID 未配置");

    const baseUrl = (config.baseUrl || DEFAULT_INWORLD_BASE_URL).replace(/\/$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const isMj = isMjVoiceConfig(config);
    const modelId = isMj ? STEERABLE_INWORLD_MODEL : (config.model || DEFAULT_INWORLD_MODEL);
    const vocalState = isMj
        ? (options?.emotion ? normalizeVocalState(options.emotion) : detectVocalState(text))
        : "neutral";
    const steering = isMj ? `[${MJ_VOCAL_STEERING[vocalState]}] ` : "";
    const ttsText = `${steering}${text}`;

    try {
        const response = await fetch(`${baseUrl}/tts/v1/voice`, {
            method: "POST",
            signal: controller.signal,
            headers: {
                Authorization: `Basic ${config.apiKey.trim()}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                text: ttsText,
                voiceId: config.defaultVoice.trim(),
                modelId,
                ...(isMj ? { deliveryMode: "BALANCED", temperature: 0.9 } : {}),
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
    { id: "inworld-tts-2-flash", name: "Inworld TTS-2 Flash（低延迟）" },
    { id: "inworld-tts-2", name: "Inworld TTS-2（自然语言情绪控制，推荐角色语音）" },
] as const;

export const DEFAULT_INWORLD_TTS_MODEL = DEFAULT_INWORLD_MODEL;
export const INWORLD_TTS_BASE_URL = DEFAULT_INWORLD_BASE_URL;
