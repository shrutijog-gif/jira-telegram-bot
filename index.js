require('dotenv').config();
const FormData = require('form-data');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Create HTTPS Agent with Keep-Alive to prevent connection resets (ECONNRESET)
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    rejectUnauthorized: true
});

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Clean up any residual temp image files from past runs on startup
try {
    const files = fs.readdirSync(__dirname);
    files.forEach(file => {
        if (file.startsWith('temp_') && file.endsWith('.jpg')) {
            fs.unlinkSync(path.join(__dirname, file));
        }
    });
} catch (e) {
    console.error("Cleanup error on start:", e.message);
}

/**
 * Executes axios requests with automatic retry on network disconnects / ECONNRESET
 */
async function axiosWithRetry(config, retries = 3, backoffMs = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await axios({
                httpsAgent,
                timeout: 30000,
                ...config
            });
        } catch (err) {
            const isNetworkErr = !err.response || 
                ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE'].includes(err.code) ||
                (err.message && err.message.includes('ECONNRESET'));
            
            if (isNetworkErr && i < retries - 1) {
                console.warn(`[Network Retry] ${err.code || err.message}. Retrying attempt ${i + 1}/${retries}...`);
                await new Promise(res => setTimeout(res, backoffMs * (i + 1)));
            } else {
                throw err;
            }
        }
    }
}

/**
 * Converts multi-line text into valid Atlassian Document Format (ADF) for Jira v3 API.
 */
function textToADF(text, userName) {
    if (!text) return undefined;
    const lines = text.split('\n');
    const content = [];

    content.push({
        type: 'paragraph',
        content: [{ type: 'text', text: `👤 Reported by: ${userName} (via Telegram)` }]
    });

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
            content.push({
                type: 'paragraph',
                content: [{ type: 'text', text: line }]
            });
        }
    }

    return {
        type: 'doc',
        version: 1,
        content: content
    };
}

/**
 * Strips leading /task command if present and formats summary & ADF description
 */
function parseTaskInput(rawText, userName) {
    const cleanText = (rawText || '').replace(/^\/task\s*/i, '').trim();
    const firstLine = cleanText.split('\n')[0].trim() || 'Telegram Task';

    let summary = `📲 ${firstLine} (by ${userName})`;
    if (summary.length > 250) {
        summary = summary.substring(0, 247) + '...';
    }
    summary = summary.replace(/[\r\n]+/g, ' ');

    const description = textToADF(cleanText, userName);

    return { summary, description, displayTitle: firstLine };
}

// ============================================
// 🔔 Chat ID Storage & Completion Notifier
// ============================================
const CHAT_ID_FILE = path.join(__dirname, 'chat_id.json');

function getTargetChatId() {
    if (process.env.TELEGRAM_CHAT_ID) return process.env.TELEGRAM_CHAT_ID;
    try {
        if (fs.existsSync(CHAT_ID_FILE)) {
            const data = JSON.parse(fs.readFileSync(CHAT_ID_FILE, 'utf8'));
            return data.chatId;
        }
    } catch (e) {}
    return null;
}

function saveTargetChatId(chatId) {
    if (!chatId) return;
    try {
        fs.writeFileSync(CHAT_ID_FILE, JSON.stringify({ chatId, updatedAt: new Date().toISOString() }), 'utf8');
        console.log(`[Notifier] Updated target group Chat ID: ${chatId}`);
    } catch (e) {
        console.error("Failed to save chat_id.json:", e.message);
    }
}

let sharp;
try {
    sharp = require('sharp');
} catch (e) {
    console.warn('[Notifier] sharp package not loaded; will use text card fallback until installed.');
}

function escapeXml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function wrapText(text, maxChars = 38, maxLines = 2) {
    const words = String(text || '').trim().split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
        if ((cur + ' ' + w).trim().length <= maxChars) {
            cur = (cur + ' ' + w).trim();
        } else {
            if (cur) lines.push(cur);
            cur = w;
            if (lines.length === maxLines - 1) break;
        }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    if (words.length > 0 && lines.join(' ').length < text.length && lines.length > 0) {
        lines[lines.length - 1] = lines[lines.length - 1].replace(/\.{0,3}$/, '') + '...';
    }
    return lines;
}

function buildResolutionCardSvg(issue) {
    const key = escapeXml(issue.key || 'TASK');
    const titleClean = (issue.title || '').replace(/^[📲\s]+/, '').trim();
    const titleLines = wrapText(titleClean, 40, 2);
    const line1 = escapeXml(titleLines[0] || 'Task Completed');
    const line2 = escapeXml(titleLines[1] || '');
    const availability = escapeXml(issue.availability || 'Staging only');
    const reporter = escapeXml(issue.reporter || 'Unknown');
    const assignee = escapeXml(issue.devAssignee || 'Unassigned');

    const width = 840;
    const height = 480;

    return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="cardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#065f46" stop-opacity="0.95" />
                <stop offset="50%" stop-color="#047857" stop-opacity="0.9" />
                <stop offset="100%" stop-color="#022c22" stop-opacity="0.98" />
            </linearGradient>

            <linearGradient id="pillGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stop-color="rgba(16, 185, 129, 0.25)" />
                <stop offset="100%" stop-color="rgba(5, 150, 105, 0.35)" />
            </linearGradient>

            <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="8" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>

            <filter id="softShadow" x="-10%" y="-10%" width="120%" height="120%">
                <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#000000" flood-opacity="0.5" />
            </filter>
        </defs>

        <style>
            .font-bold { font-family: 'Segoe UI', -apple-system, Roboto, Helvetica, sans-serif; font-weight: 800; }
            .font-semibold { font-family: 'Segoe UI', -apple-system, Roboto, Helvetica, sans-serif; font-weight: 600; }
            .font-normal { font-family: 'Segoe UI', -apple-system, Roboto, Helvetica, sans-serif; font-weight: 400; }
        </style>

        <!-- Outer Dark Surface -->
        <rect width="${width}" height="${height}" fill="#0b0f14" />

        <!-- Main Card with Rounded Corners & Subtle Glow -->
        <rect x="24" y="24" width="792" height="432" rx="28" fill="url(#cardGrad)" stroke="#10b981" stroke-width="1.8" stroke-opacity="0.4" filter="url(#softShadow)" />

        <!-- Top Left: Glowing Dot + Ticket Key -->
        <circle cx="68" cy="74" r="9" fill="#10b981" filter="url(#glow)" />
        <circle cx="68" cy="74" r="5" fill="#a7f3d0" />
        <text x="88" y="82" class="font-bold" font-size="28" fill="#ffffff" letter-spacing="0.5">${key}</text>

        <!-- Top Right: Clean Circular Badge with White Checkmark (No Shield) -->
        <circle cx="756" cy="74" r="26" fill="#10b981" filter="url(#glow)" />
        <circle cx="756" cy="74" r="23" fill="#059669" />
        <path d="M746 74 L753 81 L768 66" stroke="#ffffff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" fill="none" />

        <!-- Center Header: TASK RESOLVED -->
        <text x="420" y="162" text-anchor="middle" class="font-bold" font-size="34" fill="#ffffff" letter-spacing="2.5">TASK RESOLVED</text>

        <!-- Task Title Line 1 & Line 2 -->
        <text x="420" y="206" text-anchor="middle" class="font-normal" font-size="21" fill="#f1f5f9">${line1}</text>
        ${line2 ? `<text x="420" y="235" text-anchor="middle" class="font-normal" font-size="18" fill="#cbd5e1">${line2}</text>` : ''}

        <!-- Deployment Pill Badge (Centered) -->
        <g transform="translate(250, ${line2 ? 265 : 252})">
            <rect width="340" height="44" rx="22" fill="url(#pillGrad)" stroke="#34d399" stroke-width="1.6" />
            <circle cx="28" cy="22" r="6" fill="#34d399" filter="url(#glow)" />
            <text x="44" y="28" class="font-semibold" font-size="16" fill="#a7f3d0">Available on:</text>
            <text x="160" y="28" class="font-bold" font-size="17" fill="#ffffff">${availability}</text>
        </g>

        <!-- Divider Line -->
        <line x1="120" y1="${line2 ? 342 : 335}" x2="720" y2="${line2 ? 342 : 335}" stroke="#10b981" stroke-opacity="0.25" stroke-width="1" />

        <!-- Footer Metadata: Reporter & Assignee -->
        <text x="420" y="${line2 ? 385 : 380}" text-anchor="middle" class="font-normal" font-size="16">
            <tspan fill="#6ee7b7">👤 Reported by:</tspan>
            <tspan fill="#ffffff" class="font-semibold"> ${reporter}   </tspan>
            <tspan dx="24" fill="#6ee7b7">👨‍💻 Assigned to:</tspan>
            <tspan fill="#ffffff" class="font-semibold"> ${assignee}</tspan>
        </text>
    </svg>`;
}

async function sendCompletionNotification(issue) {
    const chatId = getTargetChatId();
    if (!chatId) {
        console.log('[Notifier] No target group Chat ID known yet. Send a message or /setgroup in your Telegram group.');
        return false;
    }

    const titleClean = escapeHtml((issue.title || '').replace(/^[📲\s]+/, '').trim());
    const reporter = escapeHtml(issue.reporter || 'Unknown');
    const assignee = escapeHtml(issue.devAssignee || 'Unassigned');
    const availability = escapeHtml(issue.availability || 'Staging only');

    // Inline button linking directly to the Jira ticket
    const inlineKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '🟢 Open in Jira ↗',
                        url: issue.jiraUrl
                    }
                ]
            ]
        }
    };

    // Try generating and sending the visual green resolution card
    if (sharp) {
        try {
            const svgStr = buildResolutionCardSvg(issue);
            const pngBuffer = await sharp(Buffer.from(svgStr)).png().toBuffer();

            const caption = 
                `✅ <b>${escapeHtml(issue.key)} Resolved!</b>\n` +
                `🚀 <b>Available on:</b> <b>${availability}</b>`;

            await bot.sendPhoto(chatId, pngBuffer, {
                caption: caption,
                parse_mode: 'HTML',
                ...inlineKeyboard
            });

            console.log(`[Notifier] Sent Visual Green Card for ${issue.key} to ${chatId}`);
            return true;
        } catch (imgErr) {
            console.error('[Notifier] Failed to generate/send green card image, falling back to text:', imgErr.message);
        }
    }

    // High-contrast fallback text card with native blockquote and button
    const fallbackText = 
        `✅ <b>TASK RESOLVED / DONE!</b>\n\n` +
        `<blockquote>` +
        `🟢 <b>${escapeHtml(issue.key)}</b> — <b>${titleClean}</b>\n\n` +
        `👤 <b>Reported by:</b> ${reporter}\n` +
        `👨‍💻 <b>Assigned to:</b> ${assignee}\n` +
        `🚀 <b>Available on:</b> <b>${availability}</b>` +
        `</blockquote>`;

    try {
        await bot.sendMessage(chatId, fallbackText, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...inlineKeyboard
        });
        console.log(`[Notifier] Sent Done notification for ${issue.key} (Available on: ${issue.availability}) to ${chatId}`);
        return true;
    } catch (err) {
        console.error(`[Notifier] Failed to send Telegram notification for ${issue.key}:`, err.message);
        return false;
    }
}

bot.on('message', async (msg) => {
    console.log("MSG received from:", msg.from?.first_name, "Chat ID:", msg.chat?.id, "Type:", msg.chat?.type);

    // Auto-memorize the group chat ID whenever any message is received in a group/supergroup
    if (msg.chat && (msg.chat.type === 'group' || msg.chat.type === 'supergroup')) {
        saveTargetChatId(msg.chat.id);
    }

    // Command to check or explicitly bind the notification group
    if (msg.text && (msg.text.trim() === '/setgroup' || msg.text.trim() === '/notifications_here' || msg.text.trim() === '/id')) {
        saveTargetChatId(msg.chat.id);
        return bot.sendMessage(
            msg.chat.id,
            `🔔 <b>Task completion notifications enabled for this group!</b>\nChat ID: <code>${msg.chat.id}</code>`,
            { parse_mode: 'HTML' }
        );
    }

    const userName = `${msg.from?.first_name || ''} ${msg.from?.last_name || ''}`.trim() || 'User';

    // =========================
    // ✅ CASE 1: Photo / Screenshot
    // =========================
    if (msg.photo && msg.photo.length > 0) {
        const captionText = msg.caption || '';
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const filePath = path.join(__dirname, `temp_${Date.now()}.jpg`);

        try {
            // 👉 Download photo using node-telegram-bot-api helper (or axios fallback)
            try {
                await bot.downloadFile(fileId, __dirname).then(downloadedPath => {
                    if (downloadedPath && fs.existsSync(downloadedPath)) {
                        fs.renameSync(downloadedPath, filePath);
                    }
                });
            } catch (dlErr) {
                console.warn("bot.downloadFile failed, trying direct axios download...", dlErr.message);
                const fileInfo = await bot.getFile(fileId);
                const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileInfo.file_path}`;
                const dlResponse = await axiosWithRetry({
                    url: fileUrl,
                    method: 'GET',
                    responseType: 'stream'
                });
                await new Promise((resolve, reject) => {
                    const writer = fs.createWriteStream(filePath);
                    dlResponse.data.pipe(writer);
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });
            }

            const { summary, description, displayTitle } = parseTaskInput(captionText || 'Screenshot Task', userName);

            // 👉 Create Jira task
            const issueRes = await axiosWithRetry({
                url: `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue`,
                method: 'POST',
                data: {
                    fields: {
                        project: { key: process.env.JIRA_PROJECT_KEY },
                        summary: summary,
                        description: description,
                        labels: ["Telegram"],
                        issuetype: { name: "Task" }
                    }
                },
                auth: {
                    username: process.env.JIRA_EMAIL,
                    password: process.env.JIRA_API_TOKEN
                },
                headers: { "Content-Type": "application/json" }
            });

            const issueKey = issueRes.data.key;

            // 👉 Upload attachment to Jira
            const form = new FormData();
            form.append('file', fs.createReadStream(filePath));

            await axiosWithRetry({
                url: `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/attachments`,
                method: 'POST',
                data: form,
                headers: {
                    ...form.getHeaders(),
                    "X-Atlassian-Token": "no-check"
                },
                auth: {
                    username: process.env.JIRA_EMAIL,
                    password: process.env.JIRA_API_TOKEN
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            bot.sendMessage(
                msg.chat.id,
                `✅ Task Created\n\n🆔 ${issueKey}\n👤 By: ${userName}\n🏷️ Label: Telegram\n📝 ${displayTitle}`
            );

        } catch (err) {
            console.error("ERROR:", err.response?.data || err.message);
            const detailMsg = err.response?.data?.errors?.summary || 
                              err.response?.data?.errors?.description || 
                              err.response?.data?.errorMessages?.[0] || 
                              err.message;
            bot.sendMessage(msg.chat.id, "❌ Failed to process screenshot: " + detailMsg);
        } finally {
            // Guarantee cleanup of temp image file under all conditions
            if (fs.existsSync(filePath)) {
                try {
                    fs.unlinkSync(filePath);
                } catch (e) {
                    console.error("Failed to delete temp file:", e.message);
                }
            }
        }

        return;
    }

    // =========================
    // ✅ CASE 2: Text /task command
    // =========================
    if (msg.text && msg.text.startsWith('/task')) {
        const { summary, description, displayTitle } = parseTaskInput(msg.text, userName);

        if (!displayTitle || displayTitle === 'Telegram Task') {
            return bot.sendMessage(msg.chat.id, '❗ Usage: /task <description>');
        }

        try {
            const response = await axiosWithRetry({
                url: `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue`,
                method: 'POST',
                data: {
                    fields: {
                        project: { key: process.env.JIRA_PROJECT_KEY },
                        summary: summary,
                        description: description,
                        labels: ["Telegram"],
                        issuetype: { name: "Task" }
                    }
                },
                auth: {
                    username: process.env.JIRA_EMAIL,
                    password: process.env.JIRA_API_TOKEN
                },
                headers: { "Content-Type": "application/json" }
            });

            bot.sendMessage(
                msg.chat.id,
                `✅ Task Created\n\n🆔 ${response.data.key}\n👤 By: ${userName}\n🏷️ Label: Telegram\n📝 ${displayTitle}`
            );

        } catch (error) {
            console.error("ERROR:", error.response?.data || error.message);
            const detailMsg = error.response?.data?.errors?.summary || 
                              error.response?.data?.errors?.description || 
                              error.response?.data?.errorMessages?.[0] || 
                              error.message;
            bot.sendMessage(msg.chat.id, "❌ Failed to create task: " + detailMsg);
        }

        return;
    }
});

module.exports = {
    bot,
    getTargetChatId,
    saveTargetChatId,
    sendCompletionNotification
};