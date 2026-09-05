// lib/tts-service.ts — 语音合成服务

import type { VoiceApiConfig, ContentAppId } from "./settings-types";
import { loadVoiceConfigs, loadBindingConfig, resolveBinding } from "./settings-storage";
import { synthesizeInworld } from "@/lib/inworld-tts";

export type VoiceApiConfigResolved = VoiceApiConfig;

/**
 * Resolve the TTS voice config for a character via the binding cascade.
 * Returns null if no voice config is bound or found.
 */
export function resolveVoiceConfig(characterId: string, appId?: ContentAppId): VoiceApiConfig | null {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, appId ?? "chat");
    if (!slot.voiceConfigId) return null;

    const configs = loadVoiceConfigs();
    return configs.find(c => c.id === slot.voiceConfigId) || null;
}

/**
 * Synthesize speech from text using the given voice config.
 * Returns an audio Blob (mp3/wav) or null if synthesis failed.
 *
 * Supported providers:
 * - Minimax: REST API → hex-encoded mp3
 * - OpenAI: REST API → binary audio blob
 * - ElevenLabs: REST API → binary audio blob
 * - F5-TTS: local bridge → binary wav blob
 * - Inworld: REST API → base64-encoded mp3
 */
export async function synthesizeSpeech(
    text: string,
    voiceConfig: VoiceApiConfig,
    options?: { emotion?: string },
): Promise<Blob | null> {
    if (!text.trim()) return null;

    const provider = voiceConfig.provider;

    if (provider === "Minimax") {
        return synthesizeMinimax(text, voiceConfig, options?.emotion);
    }

    if (provider === "OpenAI") {
        return synthesizeOpenAI(text, voiceConfig);
    }

    if (provider === "ElevenLabs") {
        return synthesizeElevenLabs(text, voiceConfig);
    }

    if (provider === "F5-TTS") {
        return synthesizeF5TTS(text, voiceConfig);
    }

    if (provider === "Inworld") {
        return synthesizeInworld(text, voiceConfig);
    }

    return null;
}

// A stalled TTS request (TCP connected but no response — cold start, rate-limit
// hold, network blip) would otherwise hang forever, since fetch has no default
// timeout. That froze voice/video calls at "对方正在说话..." until the user
// toggled the mic. Abort after a ceiling so the caller can recover.
const TTS_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = TTS_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
            throw new Error(`语音合成超时（超过 ${Math.round(timeoutMs / 1000)} 秒无响应）`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

// ── Minimax TTS ─────────────────────────────────────

// MiniMax voice_setting.emotion 支持的取值（speech-01-turbo/hd、speech-02-turbo/hd 等）。
const MINIMAX_EMOTIONS = new Set([
    "happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "neutral", "fluent",
]);

const MINIMAX_SPEED_MIN = 0.5;
const MINIMAX_SPEED_MAX = 2.0;
const MINIMAX_PITCH_MIN = -12;
const MINIMAX_PITCH_MAX = 12;

function normalizeMinimaxSpeed(speed: number | undefined): number {
    if (typeof speed !== "number" || !Number.isFinite(speed)) return 1.0;
    return Math.min(MINIMAX_SPEED_MAX, Math.max(MINIMAX_SPEED_MIN, speed));
}

function normalizeMinimaxPitch(pitch: number | undefined): number {
    if (typeof pitch !== "number" || !Number.isFinite(pitch)) return 0;
    return Math.min(MINIMAX_PITCH_MAX, Math.max(MINIMAX_PITCH_MIN, Math.round(pitch)));
}

async function synthesizeMinimax(text: string, config: VoiceApiConfig, emotion?: string): Promise<Blob | null> {
    if (!config.apiKey) throw new Error("Minimax API Key 未配置");

    const baseUrl = (config.baseUrl || "https://api.minimaxi.com/v1").replace(/\/$/, "");
    const voiceSetting: Record<string, unknown> = {
        voice_id: config.defaultVoice || "male-qn-qingse",
        speed: normalizeMinimaxSpeed(config.speechSpeed),
        vol: 1.0,
        pitch: normalizeMinimaxPitch(config.speechPitch),
    };
    const normalizedEmotion = emotion?.trim().toLowerCase();
    if (normalizedEmotion && MINIMAX_EMOTIONS.has(normalizedEmotion)) {
        voiceSetting.emotion = normalizedEmotion;
    }

    const response = await fetchWithTimeout(`${baseUrl}/t2a_v2`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: config.model || "speech-01-turbo",
            text,
            stream: false,
            ...(config.languageBoost ? { language_boost: config.languageBoost } : {}),
            voice_setting: voiceSetting,
            audio_setting: {
                sample_rate: 44100,
                bitrate: 256000,
                format: "mp3",
                channel: 1,
            },
        }),
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.base_resp?.status_msg || `Minimax API 请求失败 (${response.status})`);
    }

    const data = await response.json();
    if (data.data?.audio) {
        const hexString: string = data.data.audio;
        const bytes = new Uint8Array(hexString.length / 2);
        for (let i = 0; i < hexString.length; i += 2) {
            bytes[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
        }
        return new Blob([bytes], { type: "audio/mpeg" });
    }

    throw new Error(data.base_resp?.status_msg || "Minimax 未返回音频数据");
}

// ── OpenAI TTS ──────────────────────────────────────

async function synthesizeOpenAI(text: string, config: VoiceApiConfig): Promise<Blob | null> {
    if (!config.apiKey) throw new Error("OpenAI API Key 未配置");

    const baseUrl = config.baseUrl || "https://api.openai.com/v1";
    const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/audio/speech`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: config.model || "tts-1",
            input: text,
            voice: config.defaultVoice || "alloy",
            response_format: "mp3",
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`OpenAI TTS 请求失败 (${response.status}): ${errText}`);
    }

    const blob = await response.blob();
    return new Blob([await blob.arrayBuffer()], { type: "audio/mpeg" });
}

// ── ElevenLabs TTS ───────────────────────────────────

const ELEVENLABS_SPEED_MIN = 0.7;
const ELEVENLABS_SPEED_MAX = 1.2;
const ELEVENLABS_HIGH_QUALITY_OUTPUT_FORMAT = "mp3_44100_192";

function normalizeElevenLabsSpeed(speed: number | undefined): number {
    if (typeof speed !== "number" || !Number.isFinite(speed)) return 1.0;
    return Math.min(ELEVENLABS_SPEED_MAX, Math.max(ELEVENLABS_SPEED_MIN, speed));
}

function normalizeElevenLabsStability(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
    return Math.min(1, Math.max(0, value));
}

function normalizeElevenLabsSimilarity(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0.75;
    return Math.min(1, Math.max(0, value));
}

function normalizeElevenLabsStyle(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}

async function synthesizeElevenLabs(text: string, config: VoiceApiConfig): Promise<Blob | null> {
    if (!config.apiKey) throw new Error("ElevenLabs API Key 未配置");
    if (!config.defaultVoice?.trim()) throw new Error("ElevenLabs Voice ID 未配置");

    const baseUrl = (config.baseUrl || "https://api.elevenlabs.io/v1").replace(/\/$/, "");
    const voiceSettings: Record<string, unknown> = {
        stability: normalizeElevenLabsStability(config.elevenLabsStability),
        similarity_boost: normalizeElevenLabsSimilarity(config.elevenLabsSimilarity),
        style: normalizeElevenLabsStyle(config.elevenLabsStyle),
        use_speaker_boost: config.elevenLabsSpeakerBoost ?? true,
        speed: normalizeElevenLabsSpeed(config.speechSpeed),
    };

    const body: Record<string, unknown> = {
        text,
        model_id: config.model || "eleven_flash_v2_5",
        voice_settings: voiceSettings,
    };

    if (config.languageBoost?.trim() && config.languageBoost.trim().toLowerCase() !== "auto") {
        body.language_code = config.languageBoost.trim().toLowerCase();
    }

    const endpoint = `${baseUrl}/text-to-speech/${encodeURIComponent(config.defaultVoice.trim())}`;
    const requestInit: RequestInit = {
        method: "POST",
        headers: {
            "xi-api-key": config.apiKey.trim(),
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
        },
        body: JSON.stringify(body),
    };

    let response = await fetchWithTimeout(`${endpoint}?output_format=${ELEVENLABS_HIGH_QUALITY_OUTPUT_FORMAT}`, requestInit);
    if (!response.ok && [400, 401, 403, 404, 422].includes(response.status)) {
        response = await fetchWithTimeout(endpoint, requestInit);
    }

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`ElevenLabs TTS 请求失败 (${response.status}): ${errText.slice(0, 300)}`);
    }

    const blob = await response.blob();
    return new Blob([await blob.arrayBuffer()], { type: "audio/mpeg" });
}

// ── F5-TTS local bridge ──────────────────────────────
// F5-TTS runs as a local Python process on the user's machine. The bridge
// keeps the model loaded and exposes a tiny HTTP endpoint returning WAV data.
async function synthesizeF5TTS(text: string, config: VoiceApiConfig): Promise<Blob | null> {
    const baseUrl = (config.baseUrl || "http://127.0.0.1:7861").replace(/\/$/, "");
    const refAudio = config.f5RefAudio?.trim() || config.defaultVoice?.trim();
    if (!refAudio) throw new Error("F5-TTS 参考音频未配置");

    const response = await fetchWithTimeout(`${baseUrl}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            text,
            ref_audio: refAudio,
            ref_text: config.f5RefText || "",
            model: config.model || "F5TTS_v1_Base",
            nfe_step: config.f5NfeStep ?? 32,
            speed: config.speechSpeed ?? 1.0,
            remove_silence: config.f5RemoveSilence ?? false,
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`F5-TTS 请求失败 (${response.status}): ${errText.slice(0, 500)}`);
    }

    const blob = await response.blob();
    return new Blob([await blob.arrayBuffer()], { type: "audio/wav" });
}

// ── iOS audio playback that coexists with speech recognition ──────────
// On iOS Safari, playing TTS through an <audio> element keeps the system audio
// session in "playback" mode, which steals the mic from webkitSpeechRecognition
// and stops it from restarting on the next turn (calls go silent after one
// round). To keep hands-free multi-turn working we play through a Web Audio
// AudioContext and explicitly suspend() it after each clip so iOS hands the
// audio session back to the microphone. A shared <audio> element is kept as a
// fallback for browsers without AudioContext.

let _audioCtx: AudioContext | null = null;
let _sharedAudio: HTMLAudioElement | null = null;
let _audioUnlocked = false;
let _unlockListenerInstalled = false;

const TTS_VOLUME_KEY = "ai_phone_tts_volume_v1";
let _ttsVolume = ((): number => {
    if (typeof window === "undefined") return 1;
    try {
        const raw = window.localStorage.getItem(TTS_VOLUME_KEY);
        const v = raw == null ? 1 : Number(raw);
        return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
    } catch { return 1; }
})();
let _activeGain: GainNode | null = null;

export function getTtsVolume(): number {
    return _ttsVolume;
}

export function setTtsVolume(volume: number): void {
    _ttsVolume = Math.min(1, Math.max(0, volume));
    try { window.localStorage.setItem(TTS_VOLUME_KEY, String(_ttsVolume)); } catch { /* ignore */ }
    if (_activeGain) { try { _activeGain.gain.value = _ttsVolume; } catch { /* ignore */ } }
    if (_sharedAudio) { try { _sharedAudio.volume = _ttsVolume; } catch { /* ignore */ } }
}

let _callAudioSessionActive = false;

export function setCallAudioSessionActive(active: boolean): void {
    _callAudioSessionActive = active;
    if (!active && _audioCtx && !_activeGain) {
        try { void _audioCtx.suspend(); } catch { /* ignore */ }
    }
}

function getAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    if (!_audioCtx) {
        try {
            _audioCtx = new Ctor({ sampleRate: 44100 });
        } catch {
            try { _audioCtx = new Ctor(); } catch { return null; }
        }
    }
    return _audioCtx;
}

function getSharedAudio(): HTMLAudioElement {
    if (!_sharedAudio) {
        _sharedAudio = new Audio();
        _sharedAudio.setAttribute("playsinline", "");
    }
    return _sharedAudio;
}

function silentWavUrl(): string {
    const numSamples = 16;
    const buffer = new ArrayBuffer(44 + numSamples);
    const view = new DataView(buffer);
    const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF"); view.setUint32(4, 36 + numSamples, true); writeStr(8, "WAVE");
    writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 8000, true);
    view.setUint16(32, 1, true); view.setUint16(34, 8, true);
    writeStr(36, "data"); view.setUint32(40, numSamples, true);
    for (let i = 0; i < numSamples; i++) view.setUint8(44 + i, 128);
    return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

export function unlockAudioPlayback(): void {
    if (typeof window === "undefined") return;
    const ctx = getAudioContext();
    if (ctx && ctx.state === "suspended") {
        const keepRunning = _callAudioSessionActive;
        ctx.resume().then(() => {
            if (!keepRunning && !_activeGain && !_callAudioSessionActive) {
                try { void ctx.suspend(); } catch { /* ignore */ }
            }
        }).catch(() => {});
    }

    if (_audioUnlocked) return;
    const audio = getSharedAudio();
    const url = silentWavUrl();
    audio.muted = true;
    audio.src = url;
    const finish = () => {
        try { audio.pause(); audio.currentTime = 0; } catch {}
        audio.muted = false;
        URL.revokeObjectURL(url);
        _audioUnlocked = true;
    };
    try {
        const p = audio.play();
        if (p && typeof p.then === "function") {
            p.then(finish).catch(() => { audio.muted = false; URL.revokeObjectURL(url); });
        } else {
            finish();
        }
    } catch {
        audio.muted = false;
        URL.revokeObjectURL(url);
    }
}

function installUnlockListener(): void {
    if (_unlockListenerInstalled || typeof window === "undefined") return;
    _unlockListenerInstalled = true;
    const handler = () => { unlockAudioPlayback(); };
    window.addEventListener("touchend", handler, { passive: true });
    window.addEventListener("pointerdown", handler, { passive: true });
    window.addEventListener("mousedown", handler, { passive: true });
}

if (typeof window !== "undefined") installUnlockListener();

function decodeAudio(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
    return new Promise((resolve, reject) => {
        const ret = ctx.decodeAudioData(data, resolve, reject);
        if (ret && typeof (ret as Promise<AudioBuffer>).then === "function") {
            (ret as Promise<AudioBuffer>).then(resolve, reject);
        }
    });
}

export function playAudioBlobViaMediaElement(blob: Blob): { promise: Promise<void>; abort: () => void } {
    return playAudioBlobElement(blob);
}

function playAudioBlobElement(blob: Blob): { promise: Promise<void>; abort: () => void } {
    const url = URL.createObjectURL(blob);
    const audio = getSharedAudio();
    audio.muted = false;
    audio.volume = _ttsVolume;
    audio.src = url;

    let settled = false;
    let resolveFn: () => void = () => {};
    const finalize = () => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        URL.revokeObjectURL(url);
        try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch {}
        resolveFn();
    };
    const promise = new Promise<void>((resolve) => {
        resolveFn = resolve;
        audio.onended = finalize;
        audio.onerror = finalize;
        audio.play().catch(() => {
            finalize();
        });
    });
    return { promise, abort: finalize };
}

export function playAudioBlob(blob: Blob): { promise: Promise<void>; abort: () => void } {
    const ctx = getAudioContext();
    if (!ctx) return playAudioBlobElement(blob);

    let settled = false;
    let resolveFn: () => void = () => {};
    let source: AudioBufferSourceNode | null = null;
    let gain: GainNode | null = null;
    let fallbackAbort: (() => void) | null = null;

    const cleanupWebAudio = () => {
        if (source) {
            source.onended = null;
            try { source.stop(); } catch {}
            try { source.disconnect(); } catch {}
            source = null;
        }
        if (gain) { try { gain.disconnect(); } catch {} }
        if (_activeGain === gain) _activeGain = null;
        gain = null;
        try { ctx.suspend(); } catch {}
    };

    const finalize = () => {
        if (settled) return;
        settled = true;
        cleanupWebAudio();
        if (fallbackAbort) { fallbackAbort(); fallbackAbort = null; }
        resolveFn();
    };

    const promise = new Promise<void>((resolve) => {
        resolveFn = resolve;
        (async () => {
            try {
                if (ctx.state === "suspended") {
                    await Promise.race([
                        ctx.resume().catch(() => {}),
                        new Promise(r => setTimeout(r, 800)),
                    ]);
                }
                if (ctx.state !== "running") throw new Error("audio_context_not_running");
                const audioBuffer = await decodeAudio(ctx, await blob.arrayBuffer());
                if (settled) return;
                source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                gain = ctx.createGain();
                gain.gain.value = _ttsVolume;
                source.connect(gain);
                gain.connect(ctx.destination);
                _activeGain = gain;
                source.onended = finalize;
                source.start();
            } catch {
                if (settled) return;
                cleanupWebAudio();
                const fallback = playAudioBlobElement(blob);
                fallbackAbort = fallback.abort;
                void fallback.promise.then(() => {
                    if (settled) return;
                    settled = true;
                    fallbackAbort = null;
                    resolveFn();
                });
            }
        })();
    });

    return { promise, abort: finalize };
}
