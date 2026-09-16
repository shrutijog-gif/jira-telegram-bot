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

async function sendCompletionNotification(issue) {
    const chatId = getTargetChatId();
    if (!chatId) {
        console.log('[Notifier] No target group Chat ID known yet. Send a message or /setgroup in your Telegram group.');
        return false;
    }

    const titleClean = (issue.title || '').replace(/^[📲\s]+/, '').trim();
    const reporter = issue.reporter || 'Unknown';
    const assignee = issue.devAssignee || 'Unassigned';
    const availability = issue.availability || 'Staging only';

    const text = 
        `🎉 <b>Task Resolved / Done!</b>\n\n` +
        `🆔 <b>${issue.key}</b>\n` +
        `📝 ${titleClean}\n` +
        `👤 <b>Reported by:</b> ${reporter}\n` +
        `👨‍💻 <b>Assigned to:</b> ${assignee}\n` +
        `🚀 <b>Available on:</b> <b>${availability}</b>\n\n` +
        `🔗 <a href="${issue.jiraUrl}">View in Jira</a>`;

    try {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
        console.log(`[Notifier] Sent Done notification for ${issue.key} (Available on: ${availability}) to ${chatId}`);
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