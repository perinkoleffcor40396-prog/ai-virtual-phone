// lib/peter-vocal-personality.ts — Peter Parker's local, rule-based vocal performance layer

export type PeterVocalState =
    | "neutral"
    | "amused"
    | "playful"
    | "sarcastic"
    | "embarrassed"
    | "nervous"
    | "excited"
    | "sad"
    | "affectionate"
    | "reassuring"
    | "surprised"
    | "worried"
    | "apologetic"
    | "self_deprecating"
    | "annoyed"
    | "angry";

export type PeterVocalDelivery = {
    state: PeterVocalState;
    tags: string[];
    text: string;
};

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

function normalize(value: string): string {
    return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function has(text: string, pattern: RegExp): boolean {
    return pattern.test(text);
}

function looksLikePeterConfig(identity: string): boolean {
    return PETER_IDENTITY.test(identity);
}

/** Infer Peter's delivery locally from his reply plus the user's social context. */
export function inferPeterVocalState(text: string, userContext = ""): PeterVocalState {
    const t = normalize(text);
    const u = normalize(userContext);

    // Peter's actual wording wins: the reply itself is the strongest clue.
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

    // Compliments tend to make Peter awkward and a little shy rather than polished.
    if (has(u, /\b(you're cute|you're adorable|you're sweet|good job|proud of you|handsome|cute)\b|可愛|帥|乖|做得好|我為你驕傲/)) {
        if (has(t, /\b(uh|um|wow|thanks|thank you|stop|okay, okay|that's\.\.\.)\b|呃|謝謝|好啦|別說了/)) return "embarrassed";
        return "affectionate";
    }

    // Teasing should feel like Peter bantering back, not like an angry sarcastic voice.
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

/**
 * Add a small performance profile rather than merely naming an emotion.
 * The tags are intentionally sparse so Peter keeps a natural baseline.
 */
function tagsForState(state: PeterVocalState, text: string, userContext: string): string[] {
    const t = normalize(text);
    const u = normalize(userContext);
    const shortLine = text.trim().length <= 32;
    const hasEllipsis = /\.\.\.|……/.test(text);
    const hasQuestion = /[?？]/.test(text);
    const hasExclamation = /[!！]/.test(text);
    const hasComma = /[,，]/.test(text);

    switch (state) {
        case "apologetic":
            return has(t, /\b(i'm sorry|i am sorry|my bad)\b/) ? ["sighs", "softly"] : ["softly"];
        case "affectionate":
            return shortLine ? ["softly"] : ["softly", "warmly"];
        case "reassuring":
            return shortLine ? ["softly"] : ["softly", "calmly"];
        case "worried":
            return ["worried", "softly"];
        case "angry":
            return hasExclamation ? ["angry"] : ["angry", "firmly"];
        case "annoyed":
            return hasQuestion ? ["sarcastic"] : ["sarcastic"];
        case "surprised":
            return ["surprised"];
        case "excited":
            return hasExclamation || shortLine ? ["excited"] : ["excited", "quickly"];
        case "amused":
            return has(t, /\b(haha|lol|lmao)\b/) ? ["laughs"] : ["amused"];
        case "playful":
            return shortLine ? ["playful"] : ["playful", "lightly"];
        case "sarcastic":
            return ["sarcastic"];
        case "embarrassed":
            return hasEllipsis || hasComma ? ["nervous", "softly"] : ["nervous"];
        case "nervous":
            return hasEllipsis ? ["nervous", "softly"] : ["nervous", "hesitantly"];
        case "sad":
            return shortLine ? ["sad", "softly"] : ["sad", "softly", "slowly"];
        case "self_deprecating":
            return has(t, /\b(i'm|i am|of course|classic me)\b/) ? ["sighs", "amused"] : ["amused"];
        default:
            // Ordinary lines stay clean. Context can still make a short serious
            // answer gently spoken without forcing an artificial emotion.
            if (has(u, /\b(seriously|really|are you okay|please|i need you)\b/) && shortLine) return ["softly"];
            return [];
    }
}

/**
 * Apply a tiny rhythm cue when Peter's wording already implies a change of pace.
 * We never rewrite his actual dialogue: punctuation and wording remain intact.
 */
function rhythmTags(state: PeterVocalState, text: string): string[] {
    const trimmed = text.trim();
    const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
    const tags: string[] = [];

    if (state === "nervous" || state === "embarrassed") {
        if (/\.\.\.|……/.test(trimmed)) tags.push("hesitates");
        else if (wordCount <= 12) tags.push("hesitantly");
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

    return tags;
}

/** Prepare the exact transcript sent to Eleven v3. Non-v3 models are untouched. */
export function preparePeterVocalDelivery(
    text: string,
    configIdentity: string,
    model: string | undefined,
): PeterVocalDelivery | null {
    if (!looksLikePeterConfig(configIdentity)) return null;
    if ((model || "").trim().toLowerCase() !== "eleven_v3") return null;

    const userContext = Date.now() - latestUserContextAt <= 120_000 ? latestUserContext : "";
    const state = inferPeterVocalState(text, userContext);
    const baseTags = tagsForState(state, text, userContext);
    const rhythm = rhythmTags(state, text);

    // Keep the tag stack deliberately small. Too many simultaneous directions can
    // make v3 less predictable and less natural.
    const tags = [...baseTags, ...rhythm].slice(0, 3);
    if (tags.length === 0) return { state, tags: [], text };
    return { state, tags, text: `${tags.map(tag => `[${tag}]`).join(" ")} ${text}` };
}
