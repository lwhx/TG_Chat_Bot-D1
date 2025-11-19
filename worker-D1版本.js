/**
 * Telegram 双向机器人 Cloudflare Worker (v3.3 - D1 免费版极致优化)
 * * [核心优化保留]
 * 1. 引入内存缓存 (Memory Cache): 极大降低 D1 读取频率，响应极快。
 * 2. 全局配置预加载 (Preload): 缓存失效时，一次查询加载所有配置，节省 D1 读取行数。
 * * [部署要求]
 * 1. 绑定 D1 数据库 -> 变量名: TG_BOT_DB
 * 2. 环境变量保持不变 (BOT_TOKEN, ADMIN_IDS 等)
 */

// --- 全局内存缓存 ---
let GLOBAL_CONFIG_CACHE = {
    data: {},
    timestamp: 0,
    ttl: 60000 // 60秒缓存
};

// --- 默认配置 ---
const DEFAULT_CONFIG = {
    welcome_msg: "欢迎！在使用之前，请先完成人机验证。",
    verif_q: "问题：1+1=?\n\n提示：\n1. 正确答案不是“2”。\n2. 答案在机器人简介内，请看简介的答案进行回答。",
    verif_a: "3",
    block_threshold: "5",
    enable_image_forwarding: "true",
    enable_link_forwarding: "true",
    enable_text_forwarding: "true",
    enable_channel_forwarding: "true",
    enable_forward_forwarding: "true",
    enable_audio_forwarding: "true",
    enable_sticker_forwarding: "true",
    enable_admin_receipt: "true",
    backup_group_id: ""
};

// --- 核心处理入口 ---
export default {
    async fetch(request, env, ctx) {
        ctx.waitUntil(dbMigrate(env));
        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/verify") return handleVerificationPage(request, env);
        if (request.method === "POST" && url.pathname === "/submit_token") return handleSubmitToken(request, env);
        if (request.method === "GET" && url.pathname === "/") return new Response("Bot is Running (v3.3 UI Fixed)", { status: 200 });

        if (request.method === "POST") {
            try {
                const update = await request.json();
                ctx.waitUntil(handleUpdate(update, env));
                return new Response("OK", { status: 200 });
            } catch (e) {
                return new Response("Error", { status: 500 });
            }
        }
        return new Response("Not Found", { status: 404 });
    }
};

// --- 数据库层 (保持高效) ---

async function getConfig(key, env, fallback) {
    const now = Date.now();
    if (GLOBAL_CONFIG_CACHE.timestamp > 0 && (now - GLOBAL_CONFIG_CACHE.timestamp) < GLOBAL_CONFIG_CACHE.ttl) {
        const cachedVal = GLOBAL_CONFIG_CACHE.data[key];
        if (cachedVal !== undefined) return cachedVal;
    }
    try {
        const allRows = await env.TG_BOT_DB.prepare("SELECT * FROM config").all();
        GLOBAL_CONFIG_CACHE.data = {};
        if (allRows.results) {
            for (const row of allRows.results) {
                GLOBAL_CONFIG_CACHE.data[row.key] = row.value;
            }
        }
        GLOBAL_CONFIG_CACHE.timestamp = now;
        const dbVal = GLOBAL_CONFIG_CACHE.data[key];
        if (dbVal !== undefined) return dbVal;
    } catch (e) { console.error(e); }

    const envKey = key.toUpperCase().replace(/_MSG/, '_MESSAGE').replace(/_Q/, '_QUESTION').replace(/_A/, '_ANSWER');
    if (env[envKey]) return env[envKey];
    return fallback !== undefined ? fallback : (DEFAULT_CONFIG[key] || "");
}

async function dbConfigPut(key, value, env) {
    await env.TG_BOT_DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(key, value).run();
    GLOBAL_CONFIG_CACHE.timestamp = 0; 
}

// (其余数据库函数保持不变，为节省篇幅省略重复部分，逻辑与之前一致)
async function dbUserGetOrCreate(userId, env) {
    let user = await env.TG_BOT_DB.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first();
    if (!user) {
        try {
            await env.TG_BOT_DB.prepare("INSERT INTO users (user_id, user_state, is_blocked, block_count, first_message_sent) VALUES (?, 'new', 0, 0, 0)").bind(userId).run();
            user = { user_id: userId, user_state: 'new', is_blocked: 0, block_count: 0, first_message_sent: 0, topic_id: null, user_info_json: null };
        } catch (e) { user = await env.TG_BOT_DB.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first(); }
    }
    if (user) {
        user.is_blocked = user.is_blocked === 1;
        user.first_message_sent = user.first_message_sent === 1;
        user.user_info = user.user_info_json ? JSON.parse(user.user_info_json) : null;
    }
    return user;
}
async function dbUserUpdate(userId, data, env) {
    if (data.user_info) { data.user_info_json = JSON.stringify(data.user_info); delete data.user_info; }
    const keys = Object.keys(data); if (keys.length === 0) return;
    const fields = keys.map(key => `${key} = ?`).join(', ');
    const values = keys.map(key => (typeof data[key] === 'boolean' ? (data[key] ? 1 : 0) : data[key]));
    await env.TG_BOT_DB.prepare(`UPDATE users SET ${fields} WHERE user_id = ?`).bind(...values, userId).run();
}
async function dbTopicUserGet(topicId, env) {
    const row = await env.TG_BOT_DB.prepare("SELECT user_id FROM users WHERE topic_id = ?").bind(topicId).first();
    return row ? row.user_id : null;
}
async function dbMessageDataPut(userId, messageId, data, env) {
    await env.TG_BOT_DB.prepare("INSERT OR REPLACE INTO messages (user_id, message_id, text, date) VALUES (?, ?, ?, ?)").bind(userId, messageId, data.text, data.date).run();
}
async function dbMessageDataGet(userId, messageId, env) {
    const row = await env.TG_BOT_DB.prepare("SELECT text, date FROM messages WHERE user_id = ? AND message_id = ?").bind(userId, messageId).first();
    return row || null;
}
async function dbAdminStateDelete(userId, env) { await env.TG_BOT_DB.prepare("DELETE FROM config WHERE key = ?").bind(`admin_state:${userId}`).run(); GLOBAL_CONFIG_CACHE.timestamp = 0; }
async function dbAdminStateGet(userId, env) { return await dbConfigGet(`admin_state:${userId}`, env); }
async function dbAdminStatePut(userId, stateJson, env) { await dbConfigPut(`admin_state:${userId}`, stateJson, env); }
async function dbMigrate(env) {
    if (!env.TG_BOT_DB) return;
    const queries = [
        `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);`,
        `CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY NOT NULL, user_state TEXT NOT NULL DEFAULT 'new', is_blocked INTEGER NOT NULL DEFAULT 0, block_count INTEGER NOT NULL DEFAULT 0, first_message_sent INTEGER NOT NULL DEFAULT 0, topic_id TEXT, user_info_json TEXT);`,
        `CREATE TABLE IF NOT EXISTS messages (user_id TEXT NOT NULL, message_id TEXT NOT NULL, text TEXT, date INTEGER, PRIMARY KEY (user_id, message_id));`
    ];
    try { await env.TG_BOT_DB.batch(queries.map(q => env.TG_BOT_DB.prepare(q))); } catch (e) {}
}

// --- 辅助函数 ---
function escapeHtml(text) { return text ? text.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''; }
function getUserInfo(user, initialTimestamp = null) {
    const userId = user.id.toString();
    const rawName = (user.first_name || "") + (user.last_name ? ` ${user.last_name}` : "");
    const rawUsername = user.username ? `@${user.username}` : "无";
    const safeName = escapeHtml(rawName);
    const topicName = `${rawName.trim()} | ${userId}`.substring(0, 128);
    const timestamp = initialTimestamp ? new Date(initialTimestamp * 1000).toLocaleString('zh-CN') : new Date().toLocaleString('zh-CN');
    const usernameDisplay = rawUsername !== '无' ? `<a href="tg://user?id=${userId}">${escapeHtml(rawUsername)}</a>` : `<code>${escapeHtml(rawUsername)}</code>`;
    const infoCard = `<b>👤 用户资料卡</b>\n---\n• 昵称: <code>${safeName}</code>\n• 用户名: ${usernameDisplay}\n• ID: <code>${userId}</code>\n• 首次连接: <code>${timestamp}</code>`.trim();
    return { userId, name: rawName, username: rawUsername, topicName, infoCard };
}
function getInfoCardButtons(userId, isBlocked) {
    return { inline_keyboard: [[{ text: isBlocked ? "✅ 解除屏蔽" : "🚫 屏蔽此人", callback_data: `${isBlocked ? "unblock" : "block"}:${userId}` }], [{ text: "📌 置顶此资料卡", callback_data: `pin_card:${userId}` }]] };
}
function isPrimaryAdmin(userId, env) {
    if (!env.ADMIN_IDS) return false;
    return env.ADMIN_IDS.split(/[,，]/).map(id => id.trim()).includes(userId.toString());
}
async function getAuthorizedAdmins(env) {
    try { return JSON.parse(await getConfig('authorized_admins', env, '[]')) || []; } catch { return []; }
}
async function isAdminUser(userId, env) {
    if (isPrimaryAdmin(userId, env)) return true;
    return (await getAuthorizedAdmins(env)).includes(userId.toString());
}
async function getBlockKeywords(env) {
    try { return JSON.parse(await getConfig('block_keywords', env, '[]')) || []; } catch { return []; }
}
async function getAutoReplyRules(env) {
    try { return JSON.parse(await getConfig('keyword_responses', env, '[]')) || []; } catch { return []; }
}

// --- API 客户端 ---
async function telegramApi(token, methodName, params = {}) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${methodName}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(`${methodName} failed: ${data.description}`);
    return data.result;
}

// --- Turnstile ---
async function validateTurnstile(token, env) {
    if (!token || !env.TURNSTILE_SECRET_KEY) return false;
    try {
        const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
        });
        return (await res.json()).success === true;
    } catch { return false; }
}
async function handleVerificationPage(request, env) {
    const userId = new URL(request.url).searchParams.get('user_id');
    if (!userId || !env.TURNSTILE_SITE_KEY) return new Response("Missing Config", { status: 400 });
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><script src="https://telegram.org/js/telegram-web-app.js"></script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><style>body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:sans-serif;background-color:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#222);}#c{background:var(--tg-theme-secondary-bg-color,#f0f0f0);padding:20px;border-radius:12px;text-align:center;width:90%;max-width:360px;}#msg{margin-top:20px;font-weight:bold;min-height:24px;}.s{color:#2ea043;}.e{color:#da3633;}</style></head><body><div id="c"><h3>🛡️ 安全验证</h3><div class="cf-turnstile" data-sitekey="${env.TURNSTILE_SITE_KEY}" data-callback="onS" data-expired-callback="onE" data-error-callback="onE"></div><div id="msg"></div></div><script>const tg=window.Telegram.WebApp;tg.ready();try{tg.expand();}catch{}const msg=document.getElementById('msg');function onS(t){msg.textContent='验证中...';fetch('/submit_token',{method:'POST',body:JSON.stringify({token:t,userId:'${userId}'})}).then(r=>r.json()).then(d=>{if(d.success){msg.textContent='✅ 通过！';msg.className='s';setTimeout(()=>tg.close(),1500);}else{msg.textContent='❌ '+d.error;msg.className='e';}}).catch(()=>{msg.textContent='❌ 网络错误';msg.className='e';});}function onE(){msg.textContent='请刷新重试';msg.className='e';}</script></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
async function handleSubmitToken(request, env) {
    try {
        const { token, userId } = await request.json();
        if (!await validateTurnstile(token, env)) throw new Error("Invalid Token");
        await dbUserUpdate(userId, { user_state: "pending_verification" }, env);
        const verifQ = await getConfig('verif_q', env, DEFAULT_CONFIG.verif_q);
        await Promise.all([
            telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "✅ Cloudflare 验证通过！" }),
            telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "请回答第二道验证问题（答案在简介中）：\n\n" + verifQ })
        ]);
        return new Response(JSON.stringify({ success: true }));
    } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 400 });
    }
}

// --- 业务逻辑 ---
async function handleUpdate(update, env) {
    if (update.message) {
        if (update.message.chat.type === "private") await handlePrivateMessage(update.message, env);
        else if (update.message.chat.id.toString() === env.ADMIN_GROUP_ID) await handleAdminReply(update.message, env);
    } else if (update.edited_message && update.edited_message.chat.type === "private") {
        await handleRelayEditedMessage(update.edited_message, env);
    } else if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env);
    }
}

async function handlePrivateMessage(message, env) {
    const chatId = message.chat.id.toString();
    const text = message.text || "";
    const isPrimary = isPrimaryAdmin(chatId, env);

    if (text === "/start" || text === "/help") {
        if (isPrimary) await handleAdminConfigStart(chatId, env);
        else await handleStart(chatId, env);
        return;
    }

    const user = await dbUserGetOrCreate(chatId, env);
    if (user.is_blocked) return;
    if ((await isAdminUser(chatId, env)) && user.user_state !== "verified") {
        await dbUserUpdate(chatId, { user_state: "verified" }, env);
        user.user_state = "verified";
    }
    if (isPrimary) {
        const adminState = await dbAdminStateGet(chatId, env);
        if (adminState) { await handleAdminConfigInput(chatId, text, adminState, env); return; }
    }

    const userState = user.user_state;
    if (userState === "new" || userState === "pending_turnstile") await handleStart(chatId, env);
    else if (userState === "pending_verification") await handleVerification(chatId, text, env);
    else if (userState === "verified") await handleVerifiedMessage(message, user, env);
}

async function handleStart(chatId, env) {
    const user = await dbUserGetOrCreate(chatId, env);
    const workerUrl = (env.WORKER_URL || "").replace(/\/$/, '');
    if (!workerUrl || !env.TURNSTILE_SITE_KEY) { await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "⚠️ 配置缺失 (WORKER_URL / TURNSTILE_KEY)" }); return; }
    if (user.user_state === 'new' || user.user_state === 'pending_turnstile') {
        const welcomeMsg = await getConfig('welcome_msg', env, DEFAULT_CONFIG.welcome_msg);
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId, text: welcomeMsg + "\n\n请点击下方按钮进行安全验证：",
            reply_markup: { inline_keyboard: [[{ text: "🛡️ 点击进行人机验证", web_app: { url: `${workerUrl}/verify?user_id=${chatId}` } }]] }
        });
        if (user.user_state === 'new') await dbUserUpdate(chatId, { user_state: "pending_turnstile" }, env);
    } else if (user.user_state === 'pending_verification') {
        const verifQ = await getConfig('verif_q', env, DEFAULT_CONFIG.verif_q);
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "请继续完成问答验证：\n\n" + verifQ });
    } else {
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "您已通过验证，可以直接发送消息。" });
    }
}

async function handleVerification(chatId, answer, env) {
    const expected = await getConfig('verif_a', env, DEFAULT_CONFIG.verif_a);
    if (answer.trim() === expected.trim()) {
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "✅ 验证通过！\n**注意：第一条消息请发送纯文本。**", parse_mode: "Markdown" });
        await dbUserUpdate(chatId, { user_state: "verified" }, env);
    } else {
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "❌ 答案错误。" });
    }
}

async function handleVerifiedMessage(message, user, env) {
    const chatId = message.chat.id.toString();
    const text = message.text || "";

    if (!user.first_message_sent && !(text && !message.photo && !message.video)) {
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "⚠️ 首次消息必须是纯文本。" });
        return;
    }
    const blockKeywords = await getBlockKeywords(env);
    if (blockKeywords.length > 0 && text) {
        const threshold = parseInt(await getConfig('block_threshold', env, DEFAULT_CONFIG.block_threshold)) || 5;
        for (const keyword of blockKeywords) {
            try {
                if (new RegExp(keyword, 'gi').test(text)) {
                    const newCount = user.block_count + 1;
                    await dbUserUpdate(chatId, { block_count: newCount }, env);
                    if (newCount >= threshold) {
                        await dbUserUpdate(chatId, { is_blocked: true }, env);
                        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "❌ 触发多次屏蔽词，您已被屏蔽。" });
                    } else {
                        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: `⚠️ 消息含屏蔽词 (${newCount}/${threshold})，已拦截。` });
                    }
                    return;
                }
            } catch (e) {}
        }
    }

    // 批量加载配置
    const keys = ['enable_image_forwarding', 'enable_link_forwarding', 'enable_text_forwarding', 'enable_channel_forwarding', 'enable_forward_forwarding', 'enable_audio_forwarding', 'enable_sticker_forwarding'];
    const checks = {};
    for(const k of keys) checks[k] = (await getConfig(k, env, 'true')) === 'true';

    let allow = true; let reason = "";
    if (message.forward_from || message.forward_from_chat) {
        if (!checks.enable_forward_forwarding) { allow = false; reason = "转发消息"; }
        else if (message.forward_from_chat?.type === 'channel' && !checks.enable_channel_forwarding) { allow = false; reason = "频道转发"; }
    } else if (message.audio || message.voice) { if (!checks.enable_audio_forwarding) { allow = false; reason = "语音/音频"; } }
    else if (message.sticker || message.animation) { if (!checks.enable_sticker_forwarding) { allow = false; reason = "贴纸/GIF"; } }
    else if (message.photo || message.video || message.document) { if (!checks.enable_image_forwarding) { allow = false; reason = "媒体文件"; } }
    if (allow && (message.entities || []).some(e => e.type === 'url' || e.type === 'text_link')) { if (!checks.enable_link_forwarding) { allow = false; reason = "链接"; } }
    if (allow && text && !message.photo && !message.video && !message.forward_from) { if (!checks.enable_text_forwarding) { allow = false; reason = "纯文本"; } }

    if (!allow) { await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: `⚠️ 此类消息 (${reason}) 已被设置为不接收。` }); return; }

    const autoRules = await getAutoReplyRules(env);
    for (const rule of autoRules) {
        try { if (new RegExp(rule.keywords, 'gi').test(text)) { await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "此消息为自动回复\n\n" + rule.response }); return; } } catch (e) {}
    }

    await handleRelayToTopic(message, user, env);
}

async function handleRelayToTopic(message, user, env) {
    const userId = user.user_id;
    const { topicName, infoCard } = getUserInfo(message.from, message.date);
    let topicId = user.topic_id;

    if (!topicId) {
        try {
            const newTopic = await telegramApi(env.BOT_TOKEN, "createForumTopic", { chat_id: env.ADMIN_GROUP_ID, name: topicName });
            topicId = newTopic.message_thread_id.toString();
            await dbUserUpdate(userId, { topic_id: topicId, user_info: { name: message.from.first_name, username: message.from.username, first_message_timestamp: message.date } }, env);
            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_GROUP_ID, text: infoCard, message_thread_id: topicId, parse_mode: "HTML", reply_markup: getInfoCardButtons(userId, user.is_blocked) });
        } catch (e) { await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "服务繁忙，请稍后重试。" }); return; }
    }

    try {
        await telegramApi(env.BOT_TOKEN, "copyMessage", { chat_id: env.ADMIN_GROUP_ID, from_chat_id: userId, message_id: message.message_id, message_thread_id: topicId });
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "✅ 已送达", reply_to_message_id: message.message_id, disable_notification: true }).catch(()=>{});
        if (!user.first_message_sent) await dbUserUpdate(userId, { first_message_sent: true }, env);
        if (message.text) await dbMessageDataPut(userId, message.message_id.toString(), { text: message.text, date: message.date }, env);
        await handleBackup(message, user, env);
    } catch (e) {
        if (e.message.includes("thread")) {
            await dbUserUpdate(userId, { topic_id: null }, env);
            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "会话已过期，请重发消息。" });
        }
    }
}

async function handleBackup(message, user, env) {
    const backupId = await getConfig('backup_group_id', env, "");
    if (!backupId) return;
    const uInfo = getUserInfo(message.from);
    const header = `<b>📨 备份</b> from <a href="tg://user?id=${uInfo.userId}">${uInfo.name}</a> (ID: ${uInfo.userId})\n\n`;
    try {
        if (message.text) { await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: backupId, text: header + message.text, parse_mode: "HTML" }); }
        else { await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: backupId, text: header, parse_mode: "HTML" }); await telegramApi(env.BOT_TOKEN, "copyMessage", { chat_id: backupId, from_chat_id: message.chat.id, message_id: message.message_id }); }
    } catch(e) {}
}

async function handleAdminReply(message, env) {
    if (!message.message_thread_id || message.from.is_bot) return;
    if (!await isAdminUser(message.from.id.toString(), env)) return;
    const userId = await dbTopicUserGet(message.message_thread_id.toString(), env);
    if (!userId) return;
    try {
        await telegramApi(env.BOT_TOKEN, "copyMessage", { chat_id: userId, from_chat_id: message.chat.id, message_id: message.message_id });
        if ((await getConfig('enable_admin_receipt', env, 'true')) === 'true') {
            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: "✅ 已回复", disable_notification: true, reply_to_message_id: message.message_id }).catch(()=>{});
        }
    } catch (e) { await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: `❌ 发送失败: ${e.message}` }); }
}

async function handleRelayEditedMessage(edited, env) {
    const userId = edited.from.id.toString();
    const user = await dbUserGetOrCreate(userId, env);
    if (!user.topic_id) return;
    const stored = await dbMessageDataGet(userId, edited.message_id.toString(), env);
    const oldText = stored ? stored.text : "[未知]";
    const newText = edited.text || edited.caption || "[非文本]";
    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_GROUP_ID, message_thread_id: user.topic_id, text: `✏️ <b>消息已修改</b>\n\n<b>原内容:</b>\n${escapeHtml(oldText)}\n\n<b>新内容:</b>\n${escapeHtml(newText)}`, parse_mode: "HTML" });
    if (stored) await dbMessageDataPut(userId, edited.message_id.toString(), { text: newText, date: stored.date }, env);
}

async function handleCallbackQuery(query, env) {
    const { data, message, from } = query;
    if (data.startsWith('config:')) {
        if (!isPrimaryAdmin(from.id, env)) return telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: query.id, text: "无权操作", show_alert: true });
        await processAdminConfigCallback(query, env);
        return;
    }
    if (message.chat.id.toString() === env.ADMIN_GROUP_ID) {
        const [action, targetUserId] = data.split(':');
        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: query.id, text: "处理中..." });
        if (action === 'pin_card') await telegramApi(env.BOT_TOKEN, "pinChatMessage", { chat_id: message.chat.id, message_id: message.message_id });
        else if (action === 'block' || action === 'unblock') {
            const isBlocking = action === 'block';
            await dbUserUpdate(targetUserId, { is_blocked: isBlocking, block_count: 0 }, env);
            await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", { chat_id: message.chat.id, message_id: message.message_id, reply_markup: getInfoCardButtons(targetUserId, isBlocking) });
            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, message_thread_id: message.message_thread_id, text: isBlocking ? `❌ 用户已屏蔽` : `✅ 用户已解封` });
        }
    }
}

// --- 管理员菜单逻辑 ---
async function processAdminConfigCallback(query, env) {
    const { data, message } = query;
    const chatId = message.chat.id.toString();
    const parts = data.split(':');
    const action = parts[1];
    const key = parts[2];
    const val = parts[3];

    await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: query.id });

    if (action === 'menu') {
        if (!key) return handleAdminConfigStart(chatId, env);
        if (key === 'base') await handleAdminBaseConfigMenu(chatId, message.message_id, env);
        else if (key === 'autoreply') await handleAdminRuleList(chatId, message.message_id, env, 'keyword_responses');
        else if (key === 'keyword') await handleAdminRuleList(chatId, message.message_id, env, 'block_keywords');
        else if (key === 'filter') await handleAdminTypeBlockMenu(chatId, message.message_id, env);
        else if (key === 'backup') await handleAdminBackupConfigMenu(chatId, message.message_id, env);
        else if (key === 'authorized') await handleAdminAuthorizedConfigMenu(chatId, message.message_id, env);
    } else if (action === 'toggle') {
        await dbConfigPut(key, val, env);
        await handleAdminTypeBlockMenu(chatId, message.message_id, env);
    } else if (action === 'edit') {
        if (key.endsWith('_clear')) {
             const realKey = key.replace('_clear', '');
             await dbConfigPut(realKey, key === 'authorized_admins_clear' ? '[]' : '', env);
             if(realKey==='authorized_admins') await handleAdminAuthorizedConfigMenu(chatId, message.message_id, env);
             else await handleAdminBackupConfigMenu(chatId, message.message_id, env);
        } else {
            await dbAdminStatePut(chatId, JSON.stringify({ action: 'awaiting_input', key: key }), env);
            await telegramApi(env.BOT_TOKEN, "editMessageText", { chat_id: chatId, message_id: message.message_id, text: `请输入新的 ${key} 值 (发送 /cancel 取消):` });
        }
    } else if (action === 'add') {
        await dbAdminStatePut(chatId, JSON.stringify({ action: 'awaiting_input', key: key + '_add' }), env);
        await telegramApi(env.BOT_TOKEN, "editMessageText", { chat_id: chatId, message_id: message.message_id, text: `请输入内容 (发送 /cancel 取消):`, parse_mode: 'HTML' });
    } else if (action === 'delete') {
        await handleAdminRuleDelete(chatId, message.message_id, env, key, val);
    }
}

async function handleAdminConfigStart(chatId, env) {
    await dbAdminStateDelete(chatId, env);
    const text = "⚙️ <b>机器人配置菜单</b>";
    const markup = { inline_keyboard: [
        [{ text: "📝 基础配置", callback_data: "config:menu:base" }, { text: "🤖 自动回复", callback_data: "config:menu:autoreply" }],
        [{ text: "🚫 关键词屏蔽", callback_data: "config:menu:keyword" }, { text: "🛠 过滤与系统设置", callback_data: "config:menu:filter" }],
        [{ text: "🧑‍💻 协管员设置", callback_data: "config:menu:authorized" }, { text: "💾 备份群组", callback_data: "config:menu:backup" }]
    ]};
    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: markup });
}

// [UI 复刻核心代码] 过滤设置菜单 - 修正按钮文案和布局
async function handleAdminTypeBlockMenu(cid, mid, env) {
    const s = async (k) => (await getConfig(k, env, 'true')) === 'true';
    const txt = (v) => v ? "✅ 允许/开启" : "❌ 屏蔽/关闭";
    
    const st = {
        ar: await s('enable_admin_receipt'),
        ff: await s('enable_forward_forwarding'),
        cf: await s('enable_channel_forwarding'),
        af: await s('enable_audio_forwarding'),
        sf: await s('enable_sticker_forwarding'),
        mf: await s('enable_image_forwarding'),
        lf: await s('enable_link_forwarding'),
        tf: await s('enable_text_forwarding')
    };

    const menuText = `
🛠 <b>过滤与系统功能设置</b>

点击按钮切换状态 (切换后立即生效)。

<b>系统功能:</b>
| 功能 | 状态 |
| :--- | :--- |
| 管理员回复回执 | ${txt(st.ar)} |

<b>消息转发过滤:</b>
| 类型 | 状态 |
| :--- | :--- |
| 转发消息 (用户/群组/频道) | ${txt(st.ff)} |
| 频道转发消息 (细分) | ${txt(st.cf)} |
| 音频/语音消息 | ${txt(st.af)} |
| 贴纸/GIF (动画) | ${txt(st.sf)} |
| 图片/视频/文件 | ${txt(st.mf)} |
| 链接消息 | ${txt(st.lf)} |
| 纯文本消息 | ${txt(st.tf)} |
    `.trim();

    // 按钮生成助手 (修复了之前直接拼字符串导致 bug 的问题)
    const b = (l, k, v) => ({ text: `${l}: ${v?"✅":"❌"}`, callback_data: `config:toggle:${k}:${!v}` });

    const mk = { inline_keyboard: [
        [b("管理员回复回执", "enable_admin_receipt", st.ar)],
        [b("转发消息 (用户/群组/频道)", "enable_forward_forwarding", st.ff)],
        [b("频道转发消息 (Channel Forward)", "enable_channel_forwarding", st.cf)],
        [b("音频/语音消息 (Audio/Voice)", "enable_audio_forwarding", st.af)],
        [b("贴纸/GIF (Sticker/Animation)", "enable_sticker_forwarding", st.sf)],
        [b("图片/视频/文件 (Media)", "enable_image_forwarding", st.mf)],
        [b("链接消息 (URL/TextLink)", "enable_link_forwarding", st.lf)],
        [b("纯文本消息 (Pure Text)", "enable_text_forwarding", st.tf)],
        [{text:"⬅️ 返回主菜单", callback_data:"config:menu"}]
    ] };

    await telegramApi(env.BOT_TOKEN, mid?"editMessageText":"sendMessage", {chat_id:cid, message_id:mid, text:menuText, parse_mode:"HTML", reply_markup:mk});
}

async function handleAdminBaseConfigMenu(cid, mid, env) {
    const w = await getConfig('welcome_msg', env, '...');
    const msg = `基础配置\n欢迎语: ${escapeHtml(w).substring(0,20)}...`;
    const mk = { inline_keyboard: [[{text:"编辑欢迎语", callback_data:"config:edit:welcome_msg"}, {text:"编辑验证问题", callback_data:"config:edit:verif_q"}], [{text:"编辑答案", callback_data:"config:edit:verif_a"}, {text:"返回", callback_data:"config:menu"}]]};
    await telegramApi(env.BOT_TOKEN, mid?"editMessageText":"sendMessage", {chat_id:cid, message_id:mid, text:msg, reply_markup:mk});
}
async function handleAdminRuleList(cid, mid, env, key) {
    const list = key==='keyword_responses' ? await getAutoReplyRules(env) : await getBlockKeywords(env);
    let msg = `列表 (${list.length})`;
    const btns = list.map((item, i) => [{text: `删除 ${i+1}`, callback_data: `config:delete:${key}:${item.id||item}`}]);
    btns.push([{text:"添加新项", callback_data:`config:add:${key}`}]);
    btns.push([{text:"返回", callback_data:"config:menu"}]);
    await telegramApi(env.BOT_TOKEN, mid?"editMessageText":"sendMessage", {chat_id:cid, message_id:mid, text:msg, reply_markup:{inline_keyboard:btns}});
}
async function handleAdminBackupConfigMenu(cid, mid, env) {
    const bid = await getConfig('backup_group_id', env, '未设置');
    const mk = { inline_keyboard: [[{text:"设置ID", callback_data:"config:edit:backup_group_id"}, {text:"清除", callback_data:"config:edit:backup_group_id_clear"}], [{text:"返回", callback_data:"config:menu"}]]};
    await telegramApi(env.BOT_TOKEN, mid?"editMessageText":"sendMessage", {chat_id:cid, message_id:mid, text:`备份设置: ${bid}`, reply_markup:mk});
}
async function handleAdminAuthorizedConfigMenu(cid, mid, env) {
    const list = await getAuthorizedAdmins(env);
    const mk = { inline_keyboard: [[{text:"修改列表", callback_data:"config:edit:authorized_admins"}, {text:"清空", callback_data:"config:edit:authorized_admins_clear"}], [{text:"返回", callback_data:"config:menu"}]]};
    await telegramApi(env.BOT_TOKEN, mid?"editMessageText":"sendMessage", {chat_id:cid, message_id:mid, text:`协管员: ${list.length}人`, reply_markup:mk});
}
async function handleAdminRuleDelete(cid, mid, env, key, id) {
    let rules = key==='keyword_responses' ? await getAutoReplyRules(env) : await getBlockKeywords(env);
    if (key==='keyword_responses') rules = rules.filter(r => r.id.toString() !== id.toString());
    else rules = rules.filter(r => r !== id);
    await dbConfigPut(key, JSON.stringify(rules), env);
    await handleAdminRuleList(cid, mid, env, key);
}
async function handleAdminConfigInput(uid, text, state, env) {
    if(text==='/cancel'){ await dbAdminStateDelete(uid, env); return handleAdminConfigStart(uid, env); }
    if(state.key === 'authorized_admins') text = JSON.stringify(text.split(/[,，]/).map(i=>i.trim()).filter(Boolean));
    if(state.key.endsWith('_add')) {
        const rk = state.key.replace('_add','');
        let list = rk==='keyword_responses' ? await getAutoReplyRules(env) : await getBlockKeywords(env);
        if(rk==='keyword_responses') { const [k,r]=text.split('==='); if(k&&r) list.push({keywords:k, response:r, id:Date.now()}); }
        else list.push(text);
        text = JSON.stringify(list);
        await dbConfigPut(rk, text, env);
    } else await dbConfigPut(state.key, text, env);
    await dbAdminStateDelete(uid, env);
    await telegramApi(env.BOT_TOKEN, "sendMessage", {chat_id:uid, text:"✅ 保存成功"});
    await handleAdminConfigStart(uid, env);
}
