// lib/use-weixin-bridge.ts
// React hook：管理所有 WeChat Bot 的轮询生命周期 + 后台保活。

import { useEffect, useRef, useState, useCallback } from "react";
import { loadWeixinBots, loadKeepAlive, type WeixinBotConfig } from "./weixin-storage";
import { runBotLoop } from "./weixin-bridge";

export type BotRunStatus = {
    status: "running" | "stopped" | "error";
    message?: string;
};

// ⏸ 临时总开关：暂停微信 Bot 的 getupdates 长轮询，止血 Netlify compute
const WEIXIN_BRIDGE_PAUSED: boolean = true;

const _statusMap = new Map<string, BotRunStatus>();

export function getWeixinBotStatus(id: string): BotRunStatus {
    return _statusMap.get(id) ?? { status: "stopped" };
}

function broadcastStatus() {
    window.dispatchEvent(new CustomEvent("weixin-status-changed"));
}

// ── 保活：Wake Lock + 静音音频 ───────────────────────────────
let _wakeLock: WakeLockSentinel | null = null;
let _keepAliveAudio: HTMLAudioElement | null = null;
let _keepAliveWanted = false;
let _suspendedForCall = false;
let _suspendedForMedia = false;

function ensureAudioCreated() {
    if (_keepAliveAudio) return;
    _keepAliveAudio = new Audio();
    const sampleRate = 44100;
    const samples = sampleRate;
    const buf = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buf);
    const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); writeStr(8, "WAVE"); writeStr(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); writeStr(36, "data");
    view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, i % 2 === 0 ? 1 : -1, true);
    const blob = new Blob([buf], { type: "audio/wav" });
    _keepAliveAudio.src = URL.createObjectURL(blob);
    _keepAliveAudio.loop = true;
    _keepAliveAudio.volume = 0.01;
}

function onUserGesture() {
    if (!_keepAliveWanted || !_keepAliveAudio || _suspendedForCall || _suspendedForMedia) return;
    _keepAliveAudio.play().then(() => {
        document.removeEventListener("touchstart", onUserGesture, true);
        document.removeEventListener("click", onUserGesture, true);
    }).catch(() => {});
}

async function startKeepAlive() {
    _keepAliveWanted = true;
    if (_suspendedForCall || _suspendedForMedia) return;
    try {
        if ("wakeLock" in navigator) {
            _wakeLock = await navigator.wakeLock.request("screen");
            _wakeLock.addEventListener("release", () => { _wakeLock = null; });
        }
    } catch {}
    ensureAudioCreated();
    _keepAliveAudio!.play().catch(() => {
        document.addEventListener("touchstart", onUserGesture, { capture: true, once: false });
        document.addEventListener("click", onUserGesture, { capture: true, once: false });
    });
}

function stopKeepAlive() {
    _keepAliveWanted = false;
    _suspendedForCall = false;
    _suspendedForMedia = false;
    _wakeLock?.release().catch(() => {});
    _wakeLock = null;
    if (_keepAliveAudio) { _keepAliveAudio.pause(); _keepAliveAudio.currentTime = 0; }
    document.removeEventListener("touchstart", onUserGesture, true);
    document.removeEventListener("click", onUserGesture, true);
}

export function suspendKeepAliveForCall() {
    if (!_keepAliveWanted) return;
    _suspendedForCall = true;
    _suspendedForMedia = false;
    _wakeLock?.release().catch(() => {});
    _wakeLock = null;
    if (_keepAliveAudio) { try { _keepAliveAudio.pause(); } catch {} }
    document.removeEventListener("touchstart", onUserGesture, true);
    document.removeEventListener("click", onUserGesture, true);
}

export function resumeKeepAliveAfterCall() {
    if (!_suspendedForCall) return;
    _suspendedForCall = false;
    if (!_keepAliveWanted) return;
    void startKeepAlive();
}

function suspendKeepAliveForMedia() {
    if (!_keepAliveWanted || _suspendedForCall) return;
    _suspendedForMedia = true;
    if (_keepAliveAudio) { try { _keepAliveAudio.pause(); } catch {} }
}

function resumeKeepAliveAfterMedia() {
    if (!_suspendedForMedia) return;
    _suspendedForMedia = false;
    if (!_keepAliveWanted || _suspendedForCall) return;
    void startKeepAlive();
}

function installMediaKeepAliveGuard() {
    const onPlay = (event: Event) => {
        const target = event.target;
        if (!(target instanceof HTMLMediaElement) || target === _keepAliveAudio) return;
        suspendKeepAliveForMedia();
    };
    const onStop = (event: Event) => {
        const target = event.target;
        if (!(target instanceof HTMLMediaElement) || target === _keepAliveAudio) return;
        resumeKeepAliveAfterMedia();
    };
    document.addEventListener("play", onPlay, true);
    document.addEventListener("ended", onStop, true);
    document.addEventListener("pause", onStop, true);
    return () => {
        document.removeEventListener("play", onPlay, true);
        document.removeEventListener("ended", onStop, true);
        document.removeEventListener("pause", onStop, true);
    };
}

export function useWeixinBridge() {
    const [bots, setBots] = useState<WeixinBotConfig[]>([]);
    const abortMap = useRef(new Map<string, AbortController>());
    useEffect(() => {
        setBots(loadWeixinBots());
        const handler = () => setBots(loadWeixinBots());
        window.addEventListener("weixin-config-changed", handler);
        return () => window.removeEventListener("weixin-config-changed", handler);
    }, []);
    const startBot = useCallback((bot: WeixinBotConfig) => {
        if (WEIXIN_BRIDGE_PAUSED) {
            _statusMap.set(bot.id, { status: "stopped", message: "已暂停（为节省额度临时关闭，稍后恢复）" });
            broadcastStatus(); return;
        }
        if (abortMap.current.has(bot.id)) return;
        const ctrl = new AbortController(); abortMap.current.set(bot.id, ctrl);
        _statusMap.set(bot.id, { status: "running" }); broadcastStatus();
        runBotLoop(bot, ctrl.signal, (status, message) => { _statusMap.set(bot.id, { status, message }); broadcastStatus(); }).finally(() => {
            abortMap.current.delete(bot.id);
            if (!_statusMap.get(bot.id)?.message) { _statusMap.set(bot.id, { status: "stopped" }); broadcastStatus(); }
        });
    }, []);
    useEffect(() => {
        const activeBots = bots.filter(b => b.enabled && b.botToken.trim());
        for (const bot of activeBots) startBot(bot);
        for (const [id, ctrl] of abortMap.current) if (!activeBots.find(b => b.id === id)) { ctrl.abort(); _statusMap.set(id, { status: "stopped" }); }
        broadcastStatus();
    }, [bots, startBot]);
    useEffect(() => {
        if (loadKeepAlive()) startKeepAlive(); else stopKeepAlive();
        const removeMediaGuard = installMediaKeepAliveGuard();
        const onCfg = () => { if (loadKeepAlive()) startKeepAlive(); else stopKeepAlive(); };
        window.addEventListener("weixin-config-changed", onCfg);
        return () => { window.removeEventListener("weixin-config-changed", onCfg); removeMediaGuard(); stopKeepAlive(); };
    }, []);
    useEffect(() => {
        const onVisibility = () => {
            if (document.visibilityState !== "visible") return;
            const activeBots = loadWeixinBots().filter(b => b.enabled && b.botToken.trim());
            for (const bot of activeBots) if (!abortMap.current.has(bot.id)) startBot(bot);
            if (loadKeepAlive() && !_suspendedForCall && !_suspendedForMedia) startKeepAlive();
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => document.removeEventListener("visibilitychange", onVisibility);
    }, [startBot]);
    useEffect(() => () => { for (const ctrl of abortMap.current.values()) ctrl.abort(); }, []);
}
