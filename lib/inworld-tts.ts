// lib/inworld-tts.ts — Inworld AI TTS provider helper

import type { VoiceApiConfig } from "./settings-types";

export const DEFAULT_INWORLD_BASE_URL = "https://api.inworld.ai";
const DEFAULT_INWORLD_MODEL = "inworld-tts-2-flash";
const STEERABLE_INWORLD_MODEL = "inworld-tts-2";

type VocalState = "neutral" | "amused" | "sarcastic" | "embarrassed" | "annoyed" | "angry" | "sad" | "excited" | "affectionate" | "surprised";

// MJ should feel like Michelle Jones speaking to a real person, not like a
// voice actor reading an emotion preset. Keep the direction specific enough
// to shape prosody, but restrained enough that the cloned voice remains intact.
const MJ_VOCAL_STEERING: Record<VocalState, string> = {
    neutral: "speak as Michelle Jones in a natural private conversation: calm, understated, dryly observant, slightly guarded, relaxed pacing, restrained emotion, never announcer-like",
    amused: "speak as Michelle Jones with a small genuine smile: quietly amused, dry and lightly playful, subtle lift in intonation, restrained rather than bubbly or theatrical",
    sarcastic: "speak as Michelle Jones with dry deadpan sarcasm: controlled, slightly teasing, matter-of-fact delivery with a tiny edge of amusement, never exaggerated",
    embarrassed: "speak as Michelle Jones when she is quietly embarrassed: softer volume, slightly hesitant pacing, restrained awkwardness, trying to play it off instead of performing the emotion",
    annoyed: "speak as Michelle Jones when mildly annoyed: clipped but natural phrasing, firmer consonants, lower tolerance, controlled irritation, no shouting and no melodrama",
    angry: "speak as Michelle Jones when genuinely angry but still holding herself together: firm, tense, controlled delivery, restrained intensity, as if she refuses to lose her composure",
    sad: "speak as Michelle Jones when quietly hurt: softer and slightly slower, subdued warmth, tired restraint, emotionally affected but trying not to sound tearful or dramatic",
    excited: "speak as Michelle Jones when genuinely excited: noticeably more energetic and brighter, quicker natural pacing, spontaneous enthusiasm, but still like a real conversation rather than an announcement",
    affectionate: "speak as Michelle Jones with understated affection: warm, gentle, slightly softer and more intimate, comfortable closeness, never sugary, breathy, or overly romantic",
    surprised: "speak as Michelle Jones caught genuinely off guard: brief natural surprise at the start, slightly brighter and quicker onset, then settle back into her dry conversational style, never exaggerated",
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
 * The detector is deliberately conservative: neutral remains the default,
 * and explicit conversational cues win over punctuation alone.
 *
 * This is exported so higher-level conversation layers can reuse the exact
 * same MJ state vocabulary later instead of creating a second emotion system.
 */
export function inferMjVocalState(text: string): VocalState {
    const t = text.toLowerCase().trim();

    // Strong conversational cues first. Keep affection ahead of sadness so
    // "I miss you" does not get misclassified as a sad delivery.
    if (/\b(i love you|love ya|dear|sweetheart|miss you so much|love you so much)\b|愛你|親愛的|好想你/.test(t)) return "affectionate";
    if (/\b(sorry to hear|i'm sorry|i am sorry|sad|heartbroken|i feel awful|i feel terrible)\b|難過|傷心|心疼|好難過|很難受|好痛苦/.test(t)) return "sad";
    if (/\b(furious|pissed|enraged|hate this|i hate|i'm angry|i am angry)\b|氣死|憤怒|暴怒|討厭死|我生氣/.test(t)) return "angry";
    if (/\b(ugh|annoying|annoyed|frustrated|whatever|seriously)\b|煩死|無語|煩人|受不了|真的服了/.test(t)) return "annoyed";
    if (/\b(embarrassed|embarrassing|awkward|shy|that's embarrassing)\b|尷尬|害羞|不好意思/.test(t)) return "embarrassed";
    if (/\b(yeah, right|sure, whatever|great job|obviously|as if|sure you did)\b|呵呵|行啊|真棒|才怪|是喔|你可真行/.test(t)) return "sarcastic";
    if (/\b(lol|lmao|haha|hehe|funny|kidding|joking|that's funny)\b|哈哈|笑死|好笑|開玩笑|太逗了/.test(t)) return "amused";
    if (/\b(excited|can't wait|amazing|awesome|so happy|we did it|good news)\b|期待|太棒|超開心|好興奮|成功了|好消息/.test(t)) return "excited";
    if (/\b(omg|wow|no way|what\?|you're kidding|are you serious|wait, what)\b|天啊|什麼|真的假的|不會吧|你認真的嗎|等一下/.test(t)) return "surprised";

    // Conversational structure can also imply a subtle state.
    if (/\?{2,}|？{2,}|!{2,}|！{2,}/.test(t)) return "surprised";
    if (/\b(come here|i'm here|i am here|it's okay|it is okay|you'll be okay|you are okay|you'll be fine|i've got you|i got you)\b|過來|我在這|沒事|沒關係|會好的|有我在/.test(t)) return "affectionate";

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
        ? (options?.emotion ? normalizeVocalState(options.emotion) : inferMjVocalState(text))
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
                ...(isMj ? { deliveryMode: "BALANCED" } : {}),
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
