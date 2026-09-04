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

bot.on('message', async (msg) => {
    console.log("MSG received from:", msg.from?.first_name, "Chat ID:", msg.chat?.id);

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