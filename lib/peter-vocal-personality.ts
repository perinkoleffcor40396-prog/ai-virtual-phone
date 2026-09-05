// lib/peter-vocal-personality.ts — Peter Parker's local, rule-based vocal performance layer

export type PeterVocalState =
    | "neutral" | "amused" | "playful" | "sarcastic" | "embarrassed" | "nervous"
    | "excited" | "sad" | "affectionate" | "reassuring" | "surprised" | "worried"
    | "apologetic" | "self_deprecating" | "annoyed" | "angry";

export type PeterVocalDelivery = { state: PeterVocalState; tags: string[]; text: string };

const PETER_IDENTITY = /peter\s*(parker)?|spider[- ]?man|spidey/i;
let latestUserContext = "";
let latestUserContextAt = 0;

if (typeof window !== "undefined") {
    window.addEventListener("chat-message-pushed", (event) => {
        const message = (event as CustomEvent<{ message?: { role?: string; content?: string } }>).detail?.message;
        if (message?.role === "user" && typeof message.content === "string" && message.content.trim()) {
            latestUserContext = message.content.trim();
            latestUserContextAt = Date.now();
        }
    });
}

function normalize(value: string): string { return value.toLowerCase().replace(/\s+/g, " ").trim(); }
function has(text: string, pattern: RegExp): boolean { return pattern.test(text); }
function looksLikePeterConfig(identity: string): boolean { return PETER_IDENTITY.test(identity); }

export function inferPeterVocalState(text: string, userContext = ""): PeterVocalState {
    const t = normalize(text), u = normalize(userContext);
    if (has(t, /\b(i'm sorry|i am sorry|sorry about that|my bad|i messed up|i screwed up)\b|對不起|抱歉|我的錯|搞砸了/)) return "apologetic";
    if (has(t, /\b(i love you|love you too|miss you|missed you|you're important to me|i care about you)\b|愛你|想你|在乎你/)) return "affectionate";
    if (has(t, /\b(i've got you|i got you|i'm here|i am here|it's okay|it is okay|you're okay|you'll be okay|don't worry|we'll figure it out)\b|沒事|沒關係|會好的|別擔心|我在這|有我在|我們會想辦法/)) return "reassuring";
    if (has(t, /\b(i'm worried|i am worried|i'm scared|i am scared|please be careful|are you okay|is everyone okay|stay with me)\b|擔心|害怕|小心|沒事吧|撐住/)) return "worried";
    if (has(t, /\b(i'm angry|i am angry|that's enough|back off|leave them alone|what the hell)\b|我生氣|夠了|滾開|別碰|到底什麼/)) return "angry";
    if (has(t, /\b(ugh|seriously|come on|that's annoying|annoying|give me a break)\b|煩死|拜託|真是的|受不了/)) return "annoyed";
    if (has(t, /\b(i'm a mess|i'm an idiot|i am an idiot|i'm such a dork|i'm terrible at this|classic me|of course i did)\b|我真是個笨蛋|我搞砸了|真有我的|我就是個笨蛋/)) return "self_deprecating";
    if (has(t, /\b(oh my god|omg|no way|wait, what|you're kidding|are you serious|what\?)\b|天啊|不會吧|真的假的|你認真的嗎|什麼/)) return "surprised";
    if (has(t, /\b(i can't wait|we did it|this is awesome|that's amazing|yes!|let's go|we got this)\b|太棒了|成功了|好耶|等不及|我們做到了/)) return "excited";
    if (has(t, /\b(haha|lol|lmao|that's funny|kidding|just kidding|okay, wow)\b|哈哈|笑死|開玩笑|好笑/)) return "amused";
    if (has(t, /\b(yeah, right|sure, sure|wow, thanks|great, thanks|obviously|as if|nice one)\b|呵呵|真棒|是喔|你可真行/)) return "sarcastic";
    if (has(t, /\b(uh|um|i mean|okay, so|well\.\.\.|i guess|maybe|kind of|sort of)\b|呃|那個|我的意思是|我猜|可能吧/)) return "nervous";
    if (has(t, /\b(i'm sad|i am sad|i feel awful|i feel terrible|i miss them|i don't know what to do|it's over)\b|難過|傷心|很難受|不知道怎麼辦|結束了/)) return "sad";
    if (has(u, /\b(you're cute|you're adorable|you're sweet|good job|proud of you|handsome|cute)\b|可愛|帥|乖|做得好|我為你驕傲/)) {
        if (has(t, /\b(uh|um|wow|thanks|thank you|stop|okay, okay|that's\.\.\.)\b|呃|謝謝|好啦|別說了/)) return "embarrassed";
        return "affectionate";
    }
    if (has(u, /\b(dork|nerd|loser|idiot|geek|spider[- ]?man|spidey)\b|笨蛋|書呆子|呆子|蜘蛛人/)) {
        if (has(t, /\b(wow|thanks|gee|okay|right|sure)\b|哇|謝謝|好吧|是喔/)) return "sarcastic";
        if (has(t, /\b(haha|lol|kidding|fair|okay, you got me)\b|哈哈|開玩笑|被你說中了/)) return "amused";
        return "playful";
    }
    if (has(u, /\b(i love you|love you|i miss you|miss you|date me|kiss me|do you like me|do you love me)\b|愛你|想你|親我|喜歡我|愛不愛我/)) {
        if (has(t, /\b(uh|um|wow|i\.\.\.|okay|i don't know|maybe)\b|呃|那個|我……|我不知道|可能吧/)) return "nervous";
        return "affectionate";
    }
    if (has(u, /\b(i messed up|i screwed up|i failed|i'm sorry|i am sorry|i feel awful|i feel terrible)\b|我搞砸|我失敗|對不起|我很難受/)) {
        if (has(t, /\b(hey|it's okay|it is okay|you're okay|you'll be okay|don't worry|i've got you|i got you)\b|沒事|沒關係|會好的|別擔心|我在這|有我在/)) return "reassuring";
        if (has(t, /\b(me too|same|i know|yeah\.\.\.|i'm sorry)\b|我也是|一樣|我知道|對不起/)) return "sad";
    }
    if (has(u, /\b(danger|dangerous|hurt|injured|help|where are you|come back|be careful)\b|危險|受傷|救命|你在哪|回來|小心/)) return "worried";
    if (has(u, /\b(joke|joking|haha|lol|teasing|roast|make fun)\b|笑話|哈哈|開玩笑|吐槽|逗你/)) return "playful";
    if (has(u, /\?{2,}|？{2,}/) && has(t, /\b(what|wait|huh|seriously|really)\b|什麼|等等|真的/)) return "surprised";
    return "neutral";
}

function tagsForState(state: PeterVocalState, text: string, userContext: string): string[] {
    const t = normalize(text), u = normalize(userContext);
    const shortLine = text.trim().length <= 32;
    const hasEllipsis = /\.\.\.|……/.test(text);
    const hasQuestion = /[?？]/.test(text);
    const hasExclamation = /[!！]/.test(text);
    const hasComma = /[,，]/.test(text);
    switch (state) {
        case "apologetic": return has(t, /\b(i'm sorry|i am sorry|my bad)\b/) ? ["sighs", "softly"] : ["softly"];
        case "affectionate": return shortLine ? ["softly"] : ["softly", "warmly"];
        case "reassuring": return shortLine ? ["softly"] : ["softly", "calmly"];
        case "worried": return ["worried", "softly"];
        case "angry": return hasExclamation ? ["angry"] : ["angry", "firmly"];
        case "annoyed": return ["sarcastic"];
        case "surprised": return ["surprised"];
        case "excited": return hasExclamation || shortLine ? ["excited"] : ["excited", "quickly"];
        case "amused": return has(t, /\b(haha|lol|lmao)\b/) ? ["laughs"] : ["amused"];
        case "playful": return shortLine ? ["playful"] : ["playful", "lightly"];
        case "sarcastic": return ["sarcastic"];
        case "embarrassed": return hasEllipsis || hasComma ? ["nervous", "softly"] : ["nervous"];
        case "nervous": return hasEllipsis ? ["nervous", "softly"] : ["nervous", "hesitantly"];
        case "sad": return shortLine ? ["sad", "softly"] : ["sad", "softly", "slowly"];
        case "self_deprecating": return has(t, /\b(i'm|i am|of course|classic me)\b/) ? ["sighs", "amused"] : ["amused"];
        default: return has(u, /\b(seriously|really|are you okay|please|i need you)\b/) && shortLine ? ["softly"] : [];
    }
}

/** Peter's conversational habits: subtle cues only, never dialogue rewriting. */
function conversationalHabitTags(state: PeterVocalState, text: string, userContext: string): string[] {
    const t = normalize(text), u = normalize(userContext);
    const tags: string[] = [];
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    const shortLine = text.trim().length <= 38;

    if (["nervous", "embarrassed", "affectionate"].includes(state) && has(t, /\b(wait,? no|no,? i mean|i mean|actually|that's not what i|what i meant)\b|等等|我的意思是|其實/)) tags.push("with a self-correction");
    if (["annoyed", "sarcastic", "angry"].includes(state) && has(t, /\b(fine|okay,? fine|you're right|all right|alright|i know|okay, okay)\b|好吧|你說得對|行了|我知道/)) tags.push("softening at the end");
    if (state === "neutral" && wordCount >= 22 && has(t, /\b(because|actually|technically|basically|the thing is|if you think about it|physics|science|math)\b|因為|其實|技術上|基本上|物理|科學|數學/)) tags.push("animated while explaining");
    if (["neutral", "affectionate", "reassuring"].includes(state) && shortLine && has(u, /\b(please|promise|stay|don't leave|i need you|miss you|are you okay)\b|拜託|答應我|留下|不要走|我需要你|想你|你沒事吧/)) tags.push("gently intimate");
    if (state === "playful" && has(u, /\b(you always|you really|seriously|again|dork|nerd)\b|你總是|你真的|又來|笨蛋|書呆子/)) tags.push("boyishly teasing");
    if (state === "excited" && wordCount >= 16 && /!/.test(text)) tags.push("speaks with eager energy");
    if (["worried", "reassuring", "sad"].includes(state) && has(t, /\b(look|listen|hey|please|i need you to|you need to)\b|聽我|拜託|你要/)) tags.push("grounded and sincere");

    // His awkwardness should not sound identical every time: use wording already present
    // in the reply to choose a single subtle conversational texture.
    if (["neutral", "playful", "amused"].includes(state) && wordCount >= 6 && has(t, /\b(so\.\.\.|okay,? so|well,? yeah|i guess|honestly|apparently)\b|所以……|好吧|老實說|看來/)) {
        tags.push("casually conversational");
    }
    if (["embarrassed", "nervous"].includes(state) && has(t, /\b(thanks|thank you|you're sweet|that's nice|stop)\b|謝謝|好啦|別說了/)) {
        tags.push("awkwardly sincere");
    }
    if (state === "self_deprecating" && has(t, /\b(classic me|of course|somehow|figures)\b|真有我的|果然|偏偏/)) {
        tags.push("dryly self-deprecating");
    }
    return tags;
}

function rhythmTags(state: PeterVocalState, text: string): string[] {
    const trimmed = text.trim();
    const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
    const tags: string[] = [];
    const hasEllipsis = /\.\.\.|……/.test(trimmed);
    const hasSelfCorrection = /\b(no,?\s+i mean|i mean,? no|wait,? no|okay,? that's not|that's not what i|i mean—)/i.test(trimmed);
    const hasDefensiveTurn = /\b(i'm not|i am not|i didn't|i did not|it's not|it is not|whatever|fine)\b.*\b(okay|okay,? fine|you're right|i guess|maybe|sorry|i know)\b/i.test(trimmed);
    if (state === "nervous" || state === "embarrassed") {
        if (hasEllipsis) tags.push("hesitates"); else if (wordCount <= 12) tags.push("hesitantly");
    } else if (state === "excited") {
        if (wordCount >= 12 || /!{2,}|！{2,}/.test(trimmed)) tags.push("quickly");
    } else if (state === "sad") {
        if (wordCount >= 10) tags.push("slowly");
    } else if (state === "reassuring" || state === "affectionate") {
        if (wordCount >= 14) tags.push("with gentle pauses");
    } else if (state === "surprised") {
        if (/^["'“”‘’]?\s*(wait|what|huh|no way|oh my god)\b/i.test(trimmed)) tags.push("with a startled pause");
    } else if (state === "self_deprecating") {
        if (wordCount >= 8) tags.push("with a small pause");
    }
    if (hasSelfCorrection) tags.push("with a self-correction");
    if (hasDefensiveTurn && state !== "angry") tags.push("softening at the end");
    return tags;
}

export function preparePeterVocalDelivery(text: string, configIdentity: string, model: string | undefined): PeterVocalDelivery | null {
    if (!looksLikePeterConfig(configIdentity)) return null;
    if ((model || "").trim().toLowerCase() !== "eleven_v3") return null;
    const userContext = Date.now() - latestUserContextAt <= 120_000 ? latestUserContext : "";
    const state = inferPeterVocalState(text, userContext);
    const baseTags = tagsForState(state, text, userContext);
    const habitTags = conversationalHabitTags(state, text, userContext);
    const rhythm = rhythmTags(state, text);
    const tags = [...baseTags, ...habitTags, ...rhythm].slice(0, 3);
    if (tags.length === 0) return { state, tags: [], text };
    return { state, tags, text: `${tags.map(tag => `[${tag}]`).join(" ")} ${text}` };
}
