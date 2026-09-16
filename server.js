require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Helper: map Jira status into 4 simple columns
function mapStatusToColumn(statusName, categoryName) {
    const s = (statusName || '').trim().toLowerCase();
    const c = (categoryName || '').trim().toLowerCase();

    // Development Done / Dev Done is before testing phase (not final resolved Done)
    if ((s.includes('dev') && s.includes('done')) || s.includes('developer done')) {
        return 'dev_done';
    }

    if (s.includes('test') || s.includes('qa') || s.includes('review') || s.includes('verify')) {
        return 'testing';
    }
    if (c.includes('done') || s.includes('done') || s.includes('resolved') || s.includes('closed')) {
        return 'done';
    }
    if (c.includes('progress') || s.includes('progress') || s.includes('dev') || s.includes('doing') || s.includes('wip')) {
        return 'in_progress';
    }
    return 'backlog';
}

let discoveredReleaseFields = null;

// Helper: automatically discover ALL customfield IDs related to Release / Deployment,
// including directly querying sample issue WD-1058 to guarantee catching the exact field key.
async function getDeploymentFieldKeys() {
    if (discoveredReleaseFields) return discoveredReleaseFields;
    const fieldKeys = new Set();

    try {
        // 1. Check all field metadata for Release / Deployment / Environment keywords
        const res = await axios({
            url: `https://${process.env.JIRA_DOMAIN}/rest/api/3/field`,
            method: 'GET',
            auth: {
                username: process.env.JIRA_EMAIL,
                password: process.env.JIRA_API_TOKEN
            },
            headers: { 'Accept': 'application/json' }
        });
        const allFields = res.data || [];
        allFields.forEach(f => {
            const name = (f.name || '').trim().toLowerCase();
            if (name === 'release' || name.includes('release') || name.includes('deploy') || name.includes('environment')) {
                fieldKeys.add(f.id);
                console.log(`[Jira Metadata] Matched deployment field: "${f.name}" -> ${f.id}`);
            }
        });
    } catch (e) {
        console.warn('[Jira] Failed to query field metadata:', e.response?.data || e.message);
    }

    try {
        // 2. Direct inspection of WD-1058 to locate the exact field holding "Preprod"
        const sampleRes = await axios({
            url: `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/WD-1058`,
            method: 'GET',
            auth: {
                username: process.env.JIRA_EMAIL,
                password: process.env.JIRA_API_TOKEN
            },
            headers: { 'Accept': 'application/json' }
        });
        const sampleFields = sampleRes.data?.fields || {};
        for (const [k, v] of Object.entries(sampleFields)) {
            if (!v) continue;
            const str = JSON.stringify(v).toLowerCase();
            if (str.includes('preprod') || str.includes('production') || str.includes('staging') || str.includes('not released')) {
                fieldKeys.add(k);
                console.log(`[Jira Sample WD-1058] Found deployment key "${k}":`, v);
            }
        }
    } catch (e) {
        console.warn('[Jira] Could not inspect sample issue WD-1058:', e.response?.data || e.message);
    }

    discoveredReleaseFields = Array.from(fieldKeys);
    console.log('[Jira Final] Deployment fields list to fetch:', discoveredReleaseFields);
    return discoveredReleaseFields;
}

// Helper: normalize deployment string into Production, Preprod, Staging, or Not Released
function matchEnvString(raw) {
    if (!raw) return null;
    const lower = String(raw).trim().toLowerCase();
    if (lower.includes('released-on-prod') || (lower.includes('prod') && !lower.includes('preprod'))) {
        return 'Production';
    }
    if (lower.includes('preprod')) {
        return 'Preprod';
    }
    if (lower.includes('staging')) {
        return 'Staging';
    }
    if (lower === 'not released' || lower.includes('not released')) {
        return 'Not Released';
    }
    return null;
}

// Helper: extract deployment environment (Production, Preprod, Staging, Not Released)
function extractDeployment(fields, releaseFieldKeys) {
    // 1. Check the discovered deployment custom fields
    if (Array.isArray(releaseFieldKeys)) {
        for (const fid of releaseFieldKeys) {
            const val = fields[fid];
            if (!val) continue;
            if (typeof val === 'string') {
                const match = matchEnvString(val);
                if (match) return match;
            } else if (val.value || val.name) {
                const match = matchEnvString(val.value || val.name);
                if (match) return match;
            } else if (Array.isArray(val)) {
                for (const item of val) {
                    const match = matchEnvString(typeof item === 'string' ? item : (item?.value || item?.name));
                    if (match) return match;
                }
            }
        }
    }

    // 2. Check labels array
    if (Array.isArray(fields.labels)) {
        for (const lbl of fields.labels) {
            const match = matchEnvString(lbl);
            if (match) return match;
        }
    }

    // 3. Check components array
    if (Array.isArray(fields.components)) {
        for (const c of fields.components) {
            const match = matchEnvString(c?.name || c);
            if (match) return match;
        }
    }

    // 4. Check fixVersions array
    if (Array.isArray(fields.fixVersions)) {
        for (const v of fields.fixVersions) {
            const match = matchEnvString(v?.name || v);
            if (match) return match;
        }
    }

    // 5. Deep scan all remaining field values on the issue as fallback
    for (const [key, val] of Object.entries(fields)) {
        if (!val || key === 'summary' || key === 'description' || key === 'comment') continue;
        if (typeof val === 'string') {
            const match = matchEnvString(val);
            if (match) return match;
        } else if (typeof val === 'object' && !Array.isArray(val)) {
            const match = matchEnvString(val.value || val.name);
            if (match) return match;
        } else if (Array.isArray(val)) {
            for (const item of val) {
                const match = matchEnvString(typeof item === 'string' ? item : (item?.value || item?.name));
                if (match) return match;
            }
        }
    }

    return null;
}

// API: Fetch issues tagged with 'Telegram'
app.get('/api/issues', async (req, res) => {
    try {
        const releaseFieldKeys = await getDeploymentFieldKeys();
        const fieldList = [
            'summary', 'status', 'assignee', 'reporter', 
            'created', 'updated', 'priority', 'labels', 'components', 'fixVersions'
        ];
        if (Array.isArray(releaseFieldKeys)) {
            releaseFieldKeys.forEach(k => {
                if (!fieldList.includes(k)) fieldList.push(k);
            });
        }

        const jql = `project = "${process.env.JIRA_PROJECT_KEY}" AND labels = "Telegram" ORDER BY updated DESC`;

        let rawIssues = [];
        let startAt = 0;
        const pageSize = 100;
        let total = Infinity;

        // Paginate until all Jira issues matching JQL are retrieved
        while (rawIssues.length < total) {
            const jiraRes = await axios({
                url: `https://${process.env.JIRA_DOMAIN}/rest/api/3/search/jql`,
                method: 'GET',
                params: {
                    jql: jql,
                    startAt: startAt,
                    maxResults: pageSize,
                    fields: fieldList.join(',')
                },
                auth: {
                    username: process.env.JIRA_EMAIL,
                    password: process.env.JIRA_API_TOKEN
                },
                headers: { 'Accept': 'application/json' }
            });

            const data = jiraRes.data;
            total = data.total || 0;
            const batch = data.issues || [];
            rawIssues.push(...batch);

            if (batch.length === 0 || rawIssues.length >= total) {
                break;
            }
            startAt += batch.length;
        }

        const issues = rawIssues
            .filter(issue => {
                const s = (issue.fields?.status?.name || '').toLowerCase();
                return !s.includes('deleted') && !s.includes('invalid') && !s.includes('discard') && !s.includes('rejected');
            })
            .map(issue => {
                const fields = issue.fields || {};

            // Extract reporter from summary e.g. "📲 <Title> (by Rahul)"
            let title = fields.summary || 'Untitled';
            let reporter = 'Telegram';
            const match = title.match(/\(by\s+([^)]+)\)\s*$/i);
            if (match) {
                reporter = match[1].trim();
                title = title.replace(/\(by\s+[^)]+\)\s*$/i, '').trim();
            }
            title = title.replace(/^[📲\s]+/, '').trim();

            const statusName = fields.status?.name || 'Open';
            const categoryName = fields.status?.statusCategory?.name || 'To Do';

            // Extract only first name for developer e.g. "Jaydeep"
            let devFirstName = 'Unassigned';
            if (fields.assignee?.displayName) {
                devFirstName = fields.assignee.displayName.trim().split(/\s+/)[0];
            }

            return {
                key: issue.key,
                title: title,
                fullSummary: fields.summary,
                reporter: reporter,
                status: statusName,
                column: mapStatusToColumn(statusName, categoryName),
                devAssignee: devFirstName,
                priority: fields.priority?.name || 'Medium',
                deployment: extractDeployment(fields, releaseFieldKeys),
                created: fields.created,
                updated: fields.updated,
                jiraUrl: `https://${process.env.JIRA_DOMAIN}/browse/${issue.key}`
            };
        });

        const targetKeys = ['WD-1116', 'WD-1196', 'WD-1197', 'WD-1058'];
        const sampleDebug = issues.filter(i => targetKeys.includes(i.key));
        console.log('[DEBUG TARGET ISSUES DEPLOYMENT]:');
        sampleDebug.forEach(i => console.log(`  ${i.key} -> dev: "${i.devAssignee}", status: "${i.status}", column: "${i.column}", deployment: "${i.deployment}"`));

        res.json({
            success: true,
            totalInJira: total,
            count: issues.length,
            issues: issues
        });

    } catch (err) {
        console.error('Error fetching Jira issues:', err.response?.data || err.message);
        res.status(500).json({
            error: 'Failed to fetch issues from Jira',
            details: err.response?.data?.errorMessages || err.message
        });
    }
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// Dedicated route for Kanban Board View
app.get('/board', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'board.html'));
});

app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
