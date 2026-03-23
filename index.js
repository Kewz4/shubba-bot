/**
 * PUNCHY SUPPORT BOT 2.0 - "The Deep Learning Developer"
 * Fixed wiki fetching with correct GitHub wiki URL format
 * Fixed: Bot now properly stops responding in HUMAN HELP/SOLVED threads unless explicitly mentioned
 * NEW: Teaser video auto-hosting to Google Cloud Storage
 */

const {
    Client,
    GatewayIntentBits,
    Events,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    SlashCommandBuilder,
    REST,
    Routes,
    PermissionFlagsBits,
    MessageFlags,
    AttachmentBuilder,
    EmbedBuilder
} = require('discord.js');
const axios = require('axios');
const http = require('http');
const { Storage } = require('@google-cloud/storage');

// Initialize Google Cloud Storage
const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'shubba-solutions-storage';
const SOLUTIONS_FILE_NAME = 'solutions_database.json';

// --- 0. CLOUD RUN HEALTH CHECK SERVER ---
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Shubba is awake and watching the forums!\n');
}).listen(PORT, () => {
  console.log(`🚀 Health check server listening on port ${PORT}`);
});

// --- 1. CONFIGURATION ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'MTQ2NTE2NTIzNzM1ODU1OTM4Ng.GzMjzR.O8YH-fJay2D-4NiVSBA0fnra4c4AlpHGpfK1FA'; 
const CLIENT_ID = process.env.CLIENT_ID || '1465165237358559386'; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyB-umYe0W2nl1y7jf_fZ-X2kmlfIuSbbc4';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

/**
 * Determine if a task needs advanced thinking or can use flash response
 * @param {string} content - Message content
 * @param {boolean} hasLogFile - Whether log files are present
 * @param {boolean} isDeepAnalysis - Whether this is a deep analysis request
 * @returns {object} - { useThinking: boolean, reason: string }
 */
function shouldUseThinking(content, hasLogFile = false, isDeepAnalysis = false) {
    const contentLower = content.toLowerCase();
    
    // Always use thinking for deep analysis
    if (isDeepAnalysis || hasLogFile) {
        return { useThinking: true, reason: "Deep analysis with log files" };
    }
    
    // Use thinking for complex troubleshooting
    const complexKeywords = [
        'crash', 'error', 'not working', 'broken', 'bug',
        'conflict', 'incompatible', 'issue', 'problem',
        'analyze', 'debug', 'investigate', 'diagnose'
    ];
    
    const hasComplexKeyword = complexKeywords.some(keyword => contentLower.includes(keyword));
    
    // Use thinking if message is long and complex
    const isLongMessage = content.length > 200;
    const hasMultipleQuestions = (content.match(/\?/g) || []).length > 1;
    
    if (hasComplexKeyword && (isLongMessage || hasMultipleQuestions)) {
        return { useThinking: true, reason: "Complex troubleshooting request" };
    }
    
    // Use flash for simple questions and responses
    const simplePatterns = [
        /what\s+(is|are)\s+the\s+latest/i,
        /how\s+to\s+install/i,
        /where\s+(can|do)\s+i/i,
        /^(hi|hello|hey|thanks|thank you)/i,
        /which\s+version/i
    ];
    
    if (simplePatterns.some(pattern => pattern.test(content))) {
        return { useThinking: false, reason: "Simple question" };
    }
    
    // Default: use flash for efficiency
    return { useThinking: false, reason: "Standard response" };
}

/**
 * Call Gemini with automatic retry on transient failures.
 * 4xx errors are never retried — they indicate a permanent problem.
 */
async function callGemini(prompt, useThinking = false) {
    console.log(`🤖 Calling Gemini`);

    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await geminiLimiter.execute(async () => {
                const res = await axios.post(GEMINI_URL, {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.7,
                        maxOutputTokens: 8192
                    }
                }, {
                    timeout: 120000,
                    maxContentLength: 100 * 1024 * 1024
                });

                const parts = res.data.candidates[0].content.parts;
                const responsePart = parts.slice().reverse().find(p => !p.thought && p.text) || parts[parts.length - 1];
                return responsePart.text;
            });
        } catch (err) {
            lastErr = err;
            // Log the actual Google API error message for easier debugging
            const apiMsg = err.response?.data?.error?.message || err.response?.data?.error || '';
            if (apiMsg) console.error(`🔴 Gemini API error: ${apiMsg}`);

            // Don't retry on client errors (bad request, auth, not found, etc.)
            const status = err.response?.status;
            if (status && status >= 400 && status < 500) {
                console.error(`❌ Gemini returned ${status} — not retrying`);
                throw err;
            }

            if (attempt < 2) {
                const delay = (attempt + 1) * 3000; // 3s, 6s
                console.warn(`⚠️ Gemini attempt ${attempt + 1} failed (${err.message}), retrying in ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

const DEV_GUILD_ID = '1433991244966658072'; 

const TRELLO_KEY = process.env.TRELLO_KEY || '618879f515609c73ab1ba5c29dbc2f85'; 
const TRELLO_TOKEN = process.env.TRELLO_TOKEN || 'ATTA82e547bd0cfe7b12062b08afcae7359d46e695b0de3cda7ea6d5aa2d0163eae1E803C471';
const TRELLO_BOARD_ID = 'WYGkEFgp';

const FAQ_CHANNEL_ID = '1433994561847562260';
const KNOWN_ISSUES_ID = '1450523790793773240';
const SUPPORT_FORUM_ID = '1433994315402838127';
const WIKI_FORUM_ID = '1465397633085345914'; // Wiki questions forum
const BUG_FIXES_CHANNEL_ID = '1445084222816518174'; // Bug fixes announcements
const MUSIC_CHANNEL_ID = '1466212181845737674'; // ballofgum_'s music channel
const BALLOFGUM_USER_ID = '777561200744595486';

// ✨ NEW: Teasers channel
const TEASERS_CHANNEL_ID = '1441945608993771710';       // Channel Shubba watches for new videos
const TEASER_OUTPUT_CHANNEL_ID = '1445064610188230736'; // Channel Shubba posts the hosted link to
const TEASERS_GCS_FOLDER = 'teasers'; // Folder inside your GCS bucket

const GALLERY_CHANNEL_ID = '1451583342972633341';
const ADDONS_CHANNEL_ID = '1452338871034445844';
const SUGGESTIONS_CHANNEL_ID = '1433994233567776878';
const ROADMAP_CHANNEL_ID = '1445072140733780058';

// Discord message link regex: https://discord.com/channels/GUILD/CHANNEL/MESSAGE
const DISCORD_MSG_LINK_REGEX = /https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;

// Supported video content types for teaser uploads
const VIDEO_CONTENT_TYPES = {
    'mp4': 'video/mp4',
    'mov': 'video/quicktime',
    'webm': 'video/webm',
    'mkv': 'video/x-matroska',
    'avi': 'video/x-msvideo',
    'gif': 'image/gif'
};

const DEV_IDS = ['422458713987612685', '1413670292970274836'];
const OWNER_ID = '422458713987612685'; // Primary owner (kewz.)
const PUNCHYMAN_ID = '1413670292970274836'; // Co-owner/developer (PunchyMan)
const WIKI_LINK = 'https://github.com/punchy-mod/punchy-wiki/wiki';

const TAG_CATEGORIES = {
    VERSIONS: ['All', '1.20.1', '1.21.1', '1.21.5', '1.21.11'],
    LOADERS: ['Fabric', 'Forge', 'NeoForge'],
    ISSUES: ['Visual Bug', 'Animation Bug', 'Modpack Issue', 'Compatibility Issue', 'Crash / Fatal Error', 'Duplicate']
};

// MULTILINGUAL SUPPORT - Language codes matching wiki folder structure
const SUPPORTED_LANGUAGES = {
    'EN-US': { name: 'English', nativeName: 'English', wikiCode: 'EN-US' },
    'DE-DE': { name: 'German', nativeName: 'Deutsch', wikiCode: 'DE-DE' },
    'ES-ES': { name: 'Spanish', nativeName: 'Español', wikiCode: 'ES-ES' },
    'FR-FR': { name: 'French', nativeName: 'Français', wikiCode: 'FR-FR' },
    'JA-JP': { name: 'Japanese', nativeName: '日本語', wikiCode: 'JA-JP' },
    'PT-BR': { name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)', wikiCode: 'PT-BR' },
    'RU-RU': { name: 'Russian', nativeName: 'Русский', wikiCode: 'RU-RU' },
    'ZH-CN': { name: 'Chinese (Simplified)', nativeName: '简体中文', wikiCode: 'ZH-CN' }
};

// MODRINTH API CONFIGURATION
const MODRINTH_PROJECT_ID = 'punchy-fpa'; // Modrinth project slug
const MODRINTH_API_BASE = 'https://api.modrinth.com/v2';

// SOLUTIONS STORAGE
let CURRENT_VERSION_SET = '2.4'; // Current version being documented
let SOLUTIONS_BY_VERSION = {}; // { '2.1': [...solutions], '2.2': [...solutions] }
const MAX_SOLUTIONS_PER_VERSION = 50;

// GitHub wiki raw content URLs - language will be dynamically inserted
const WIKI_BASE_URL = 'https://raw.githubusercontent.com/wiki/punchy-mod/punchy-wiki/';
const WIKI_PAGES = [
    'Punchy!-Resource-Pack-Compatibility-Guide',
    'Punchy!-Mod-Debug-Position',
    'Specific-Animation-&-More-Tuning-System',
    'Punchy!-Model-Parts-Guide',
    'Punchy!-Resource-Pack-Models-and-Geo-Mapping'
];

/**
 * Detect language from text content
 * Returns language code (e.g., 'EN-US', 'ZH-CN')
 */
function detectLanguage(text) {
    const textLower = text.toLowerCase();
    
    // Check for Chinese characters
    if (/[\u4e00-\u9fa5]/.test(text)) {
        return 'ZH-CN';
    }
    
    // Check for Japanese characters (Hiragana, Katakana, Kanji)
    if (/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/.test(text)) {
        return 'JA-JP';
    }
    
    // Check for Cyrillic (Russian)
    if (/[\u0400-\u04ff]/.test(text)) {
        return 'RU-RU';
    }
    
    // Check for common words in other languages
    const languageKeywords = {
        'DE-DE': ['der', 'die', 'das', 'und', 'ich', 'ist', 'nicht', 'haben', 'werden', 'können', 'mein', 'fehler', 'problem', 'hilfe'],
        'ES-ES': ['el', 'la', 'de', 'que', 'y', 'es', 'no', 'un', 'por', 'con', 'mi', 'error', 'problema', 'ayuda'],
        'FR-FR': ['le', 'de', 'un', 'et', 'être', 'avoir', 'que', 'pour', 'dans', 'ce', 'mon', 'erreur', 'problème', 'aide'],
        'PT-BR': ['o', 'de', 'que', 'e', 'do', 'da', 'em', 'um', 'para', 'com', 'não', 'meu', 'erro', 'problema', 'ajuda']
    };
    
    let maxScore = 0;
    let detectedLang = 'EN-US';
    
    Object.entries(languageKeywords).forEach(([lang, keywords]) => {
        let score = 0;
        keywords.forEach(keyword => {
            const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
            const matches = textLower.match(regex);
            if (matches) score += matches.length;
        });
        
        if (score > maxScore) {
            maxScore = score;
            detectedLang = lang;
        }
    });
    
    // If score is too low, default to English
    return maxScore >= 2 ? detectedLang : 'EN-US';
}

/**
 * Get Discord markdown hyperlink
 * Wiki URL format: https://github.com/punchy-mod/punchy-wiki/wiki/PageName-LANG-CODE
 */
function getWikiLink(pageName, langCode) {
    const url = `https://github.com/punchy-mod/punchy-wiki/wiki/${pageName}-${langCode}`;
    return `<${url}>`; // Use angle brackets to suppress Discord embeds
}

// State Tracking
let DYNAMIC_KNOWLEDGE_CACHE = {}; // Cache per language: { 'EN-US': { content: '', time: 0 }, ... }
const KNOWLEDGE_CACHE_DURATION = 10 * 60 * 1000;

let LATEST_VERSIONS = {}; // Store latest version info

const managedThreads = new Set(); 
const pausedThreads = new Set(); 
const processingThreads = new Set(); 
const threadMemory = {}; 

// --- RATE LIMITING SYSTEM (PAID TIER) ---
class RateLimiter {
    constructor(maxRequests = 1000, perMinutes = 1) {
        this.maxRequests = maxRequests;
        this.perMinutes = perMinutes;
        this.requests = [];
        this.consecutiveErrors = 0;
        this.lastErrorTime = 0;
    }

    async waitForSlot() {
        const now = Date.now();
        const windowStart = now - (this.perMinutes * 60 * 1000);
        
        this.requests = this.requests.filter(time => time > windowStart);
        
        if (this.consecutiveErrors > 0) {
            const backoffTime = Math.min(1000 * Math.pow(2, this.consecutiveErrors - 1), 30000);
            if (now - this.lastErrorTime < backoffTime) {
                const waitTime = backoffTime - (now - this.lastErrorTime);
                console.log(`⏸️ Backoff: waiting ${Math.ceil(waitTime / 1000)}s after errors...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
        
        if (this.requests.length >= this.maxRequests) {
            const oldestRequest = this.requests[0];
            const waitTime = (oldestRequest + (this.perMinutes * 60 * 1000)) - now + 100;
            
            if (waitTime > 0) {
                console.log(`⏳ Rate limit: waiting ${Math.ceil(waitTime / 1000)}s...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                return this.waitForSlot();
            }
        }
        
        this.requests.push(now);
    }

    async execute(fn) {
        await this.waitForSlot();
        try {
            const result = await fn();
            this.consecutiveErrors = 0;
            return result;
        } catch (error) {
            if (error.response?.status === 429) {
                this.consecutiveErrors++;
                this.lastErrorTime = Date.now();
                console.log(`⚠️ 429 detected (error #${this.consecutiveErrors}), implementing backoff...`);
                
                const backoffTime = Math.min(5000 * Math.pow(2, this.consecutiveErrors - 1), 60000);
                await new Promise(resolve => setTimeout(resolve, backoffTime));
                
                return this.execute(fn);
            }
            throw error;
        }
    }

    resetErrors() {
        this.consecutiveErrors = 0;
    }
}

const geminiLimiter = new RateLimiter(500, 1);

// --- 2. GOOGLE CLOUD STORAGE SOLUTIONS PERSISTENCE ---

/**
 * Load solutions from Google Cloud Storage
 */
async function loadSolutionsFromGCS() {
    try {
        const bucket = storage.bucket(BUCKET_NAME);
        const file = bucket.file(SOLUTIONS_FILE_NAME);
        
        const [exists] = await file.exists();
        if (!exists) {
            console.log("📝 No solutions file found in GCS. Starting fresh.");
            SOLUTIONS_BY_VERSION = { '2.1': [] };
            CURRENT_VERSION_SET = '2.1';
            await saveSolutionsToGCS();
            return;
        }
        
        const [contents] = await file.download();
        const parsed = JSON.parse(contents.toString('utf8'));
        
        SOLUTIONS_BY_VERSION = parsed.solutions || {};
        CURRENT_VERSION_SET = parsed.currentVersion || '2.1';
        
        console.log(`✅ Loaded solutions from GCS. Current version: ${CURRENT_VERSION_SET}`);
        console.log(`   Solutions by version:`, Object.keys(SOLUTIONS_BY_VERSION).map(v => `${v}: ${SOLUTIONS_BY_VERSION[v].length}`).join(', '));
    } catch (e) {
        console.error("⚠️ Error loading solutions from GCS:", e.message);
        // Initialize with defaults if load fails
        SOLUTIONS_BY_VERSION = { '2.1': [] };
        CURRENT_VERSION_SET = '2.1';
    }
}

/**
 * Save solutions to Google Cloud Storage
 */
async function saveSolutionsToGCS() {
    try {
        const bucket = storage.bucket(BUCKET_NAME);
        const file = bucket.file(SOLUTIONS_FILE_NAME);
        
        const data = {
            currentVersion: CURRENT_VERSION_SET,
            solutions: SOLUTIONS_BY_VERSION,
            lastUpdated: new Date().toISOString()
        };
        
        await file.save(JSON.stringify(data, null, 2), {
            contentType: 'application/json',
            metadata: {
                cacheControl: 'no-cache',
            }
        });
        
        console.log(`💾 Saved solutions to GCS. Version ${CURRENT_VERSION_SET}: ${SOLUTIONS_BY_VERSION[CURRENT_VERSION_SET]?.length || 0} solutions`);
    } catch (e) {
        console.error("⚠️ Error saving solutions to GCS:", e.message);
        console.error("   Make sure the bucket exists and Cloud Run has permissions.");
    }
}

/**
 * Switch to a new version set (owner only)
 */
async function switchVersionSet(newVersion) {
    console.log(`🔄 Switching from version ${CURRENT_VERSION_SET} to ${newVersion}`);
    CURRENT_VERSION_SET = newVersion;
    
    // Create new version array if it doesn't exist
    if (!SOLUTIONS_BY_VERSION[newVersion]) {
        SOLUTIONS_BY_VERSION[newVersion] = [];
    }
    
    await saveSolutionsToGCS();
    return `✅ Now documenting solutions for version **${newVersion}**. Previous versions are preserved in the database.`;
}

// ============================================================
// ✨ NEW: FILE HOSTING TO GOOGLE CLOUD STORAGE
// ============================================================

/**
 * Check if an attachment is a video (or gif)
 */
function isVideoAttachment(attachment) {
    const nameLower = attachment.name.toLowerCase();
    const ext = nameLower.split('.').pop();
    const contentType = attachment.contentType || '';
    return (
        contentType.startsWith('video/') ||
        contentType === 'image/gif' ||
        Object.keys(VIDEO_CONTENT_TYPES).includes(ext)
    );
}

/**
 * Format file size for display (e.g. "12.4 MB")
 */
function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Core GCS upload function — works for ANY file type, any folder.
 * attachment: { name, url, contentType, size } — compatible with Discord attachment objects
 *             OR a plain object { name, url, contentType } when built manually.
 * folder: GCS subfolder (default: TEASERS_GCS_FOLDER)
 * uploadedBy: display name string for metadata
 */
async function uploadFileToGCS(attachment, folder = TEASERS_GCS_FOLDER, uploadedBy = 'Shubba Bot') {
    try {
        console.log(`📤 Uploading to GCS: ${attachment.name}`);

        // Guess content type from extension if not provided
        const ext = attachment.name.toLowerCase().split('.').pop();
        const mimeMap = {
            // Video
            'mp4': 'video/mp4', 'mov': 'video/quicktime', 'webm': 'video/webm',
            'mkv': 'video/x-matroska', 'avi': 'video/x-msvideo',
            // Image
            'gif': 'image/gif', 'png': 'image/png', 'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg', 'webp': 'image/webp',
            // Audio
            'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg', 'flac': 'audio/flac',
            // Docs / misc
            'pdf': 'application/pdf', 'zip': 'application/zip',
            'txt': 'text/plain', 'json': 'application/json',
        };
        const contentType = attachment.contentType || mimeMap[ext] || 'application/octet-stream';

        // Unique timestamped path
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const gcsFileName = `${folder}/${timestamp}_${safeName}`;

        // Download from Discord CDN
        const response = await axios.get(attachment.url, {
            responseType: 'arraybuffer',
            timeout: 180000,             // 3 min for large files
            maxContentLength: 500 * 1024 * 1024  // 500 MB max
        });

        const buffer = Buffer.from(response.data);
        console.log(`📥 Downloaded ${buffer.length} bytes`);

        // Upload to GCS as public
        const bucket = storage.bucket(BUCKET_NAME);
        const file = bucket.file(gcsFileName);
        await file.save(buffer, {
            contentType,
            metadata: {
                cacheControl: 'public, max-age=31536000',
                metadata: {
                    originalName: attachment.name,
                    uploadedBy,
                    uploadedAt: new Date().toISOString(),
                    source: 'Shubba Bot Upload'
                }
            }
            // Note: public access is handled at bucket level via IAM
            // (gsutil iam ch allUsers:objectViewer gs://shubba-solutions-storage)
        });

        const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${gcsFileName}`;
        console.log(`✅ Uploaded! URL: ${publicUrl}`);
        return { url: publicUrl, fileName: gcsFileName, originalName: attachment.name, size: buffer.length, contentType };

    } catch (e) {
        console.error(`❌ GCS upload failed:`, e.message);
        return null;
    }
}

/**
 * Fetch a Discord message by its link and return it.
 * Link format: https://discord.com/channels/GUILD/CHANNEL/MESSAGE
 */
async function fetchMessageFromLink(link) {
    const match = link.match(DISCORD_MSG_LINK_REGEX);
    if (!match) return null;
    const [, guildId, channelId, messageId] = match;
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) return null;
        const msg = await channel.messages.fetch(messageId);
        return msg || null;
    } catch (e) {
        console.error(`❌ Could not fetch message from link: ${e.message}`);
        return null;
    }
}

/**
 * Handle a new message in the teasers channel.
 * Silently uploads the video to GCS and posts the link to TEASER_OUTPUT_CHANNEL_ID.
 * Does NOT reply or send anything in the teasers channel itself.
 */
async function handleTeaserMessage(message) {
    const videoAttachments = Array.from(message.attachments.values()).filter(isVideoAttachment);
    if (videoAttachments.length === 0) return; // Nothing to do

    const targetVideo = videoAttachments[videoAttachments.length - 1]; // Use last attachment
    console.log(`🎬 Auto-uploading teaser: ${targetVideo.name} from ${message.author.username}`);

    const result = await uploadFileToGCS(targetVideo, TEASERS_GCS_FOLDER, message.author.username);
    if (!result) {
        console.error(`❌ Teaser upload failed silently for ${targetVideo.name}`);
        return;
    }

    // Post the link to the output channel, NOT the teasers channel
    try {
        const outputChannel = await client.channels.fetch(TEASER_OUTPUT_CHANNEL_ID);
        const outputMsg = [
            `🎬 **New teaser uploaded by ${message.author.username}!**`,
            ``,
            `📁 **File:** \`${result.originalName}\``,
            `📦 **Size:** ${formatFileSize(result.size)}`,
            `🔗 **Hosted URL:** <${result.url}>`,
            ``,
            `*Permanent public link — won't expire like Discord CDN links.*`
        ].join('\n');
        await outputChannel.send(outputMsg);
        console.log(`📋 Teaser link posted to output channel: ${result.url}`);
    } catch (e) {
        console.error(`❌ Failed to post teaser link to output channel:`, e.message);
    }
}

/**
 * Handle an owner/dev manual upload request.
 * Usage (DM or any channel, must tag Shubba):
 *   - Attach ANY file → uploads it and returns the link
 *   - Include a Discord message link → fetches that message's attachment and uploads it
 *
 * Returns the result object if successful, or sends an error reply.
 */
async function handleOwnerUpload(message) {
    await message.channel.sendTyping();

    // ── Priority 1: Direct attachments on THIS message ──────────────────────
    if (message.attachments.size > 0) {
        const attachmentsToUpload = Array.from(message.attachments.values());
        const results = [];
        const statusMsg = await message.reply(`⏳ **Uploading ${attachmentsToUpload.length} file(s) to cloud storage...**`);

        for (const att of attachmentsToUpload) {
            const result = await uploadFileToGCS(att, TEASERS_GCS_FOLDER, message.author.username);
            if (result) results.push(result);
        }

        if (results.length === 0) {
            return statusMsg.edit(`❌ **All uploads failed.** Check the bot logs.`);
        }

        const lines = [`✅ **Uploaded ${results.length}/${attachmentsToUpload.length} file(s) successfully!**`, ``];
        results.forEach(r => {
            lines.push(`📁 **${r.originalName}** (${formatFileSize(r.size)})`);
            lines.push(`🔗 <${r.url}>`);
            lines.push(``);
        });
        lines.push(`*Links are permanent and publicly accessible.*`);
        return statusMsg.edit(lines.join('\n'));
    }

    // ── Priority 2: Discord message link in message content ─────────────────
    const msgLinkMatch = message.content.match(DISCORD_MSG_LINK_REGEX);
    if (msgLinkMatch) {
        const statusMsg = await message.reply(`⏳ **Fetching message and uploading attachment...**`);
        const targetMsg = await fetchMessageFromLink(msgLinkMatch[0]);

        if (!targetMsg) {
            return statusMsg.edit(`❌ **Could not fetch that message.** Make sure Shubba has access to that channel.`);
        }

        const allAttachments = Array.from(targetMsg.attachments.values());
        if (allAttachments.length === 0) {
            return statusMsg.edit(`❌ **No attachments found in that message.** The message exists but has no files attached.`);
        }

        // Upload all attachments found in the target message
        const results = [];
        for (const att of allAttachments) {
            const result = await uploadFileToGCS(att, TEASERS_GCS_FOLDER, message.author.username);
            if (result) results.push(result);
        }

        if (results.length === 0) {
            return statusMsg.edit(`❌ **Upload failed.** Could not upload the file(s) from that message.`);
        }

        const lines = [`✅ **Uploaded ${results.length} file(s) from the linked message!**`, ``];
        results.forEach(r => {
            lines.push(`📁 **${r.originalName}** (${formatFileSize(r.size)})`);
            lines.push(`🔗 <${r.url}>`);
            lines.push(``);
        });
        lines.push(`*Links are permanent and publicly accessible.*`);
        return statusMsg.edit(lines.join('\n'));
    }

    // ── Nothing found ────────────────────────────────────────────────────────
    return message.reply([
        `⚠️ **No file or message link found.**`,
        ``,
        `**How to upload:**`,
        `• **Attach a file** to your message → Shubba uploads it`,
        `• **Paste a Discord message link** → Shubba fetches and uploads its attachments`,
        `  Example: \`https://discord.com/channels/SERVER/CHANNEL/MESSAGE_ID\``
    ].join('\n'));
}

// ============================================================
// END OF FILE HOSTING FEATURE
// ============================================================

// --- 3. THREAD MEMORY MANAGEMENT ---

function getThreadMemory(threadId) {
    if (!threadMemory[threadId]) {
        threadMemory[threadId] = {
            hasLog: false,
            hasModlist: false,
            conversationHistory: [],
            userInfo: {
                version: null,
                loader: null,
                mods: [],
                issues: []
            },
            attachments: [],
            askedQuestions: new Set(),
            solveAttempts: [],
            lastUpdateTime: Date.now()
        };
    }
    return threadMemory[threadId];
}

function addToThreadMemory(threadId, author, content, isBot = false) {
    const memory = getThreadMemory(threadId);
    memory.conversationHistory.push({
        author: author,
        content: content,
        timestamp: Date.now(),
        isBot: isBot
    });
    
    if (memory.conversationHistory.length > 30) {
        memory.conversationHistory = memory.conversationHistory.slice(-30);
    }
    
    memory.lastUpdateTime = Date.now();
}

function buildConversationContext(threadId) {
    const memory = getThreadMemory(threadId);
    let context = "=== CONVERSATION HISTORY ===\n";
    
    memory.conversationHistory.forEach(msg => {
        const speaker = msg.isBot ? "Shubba" : msg.author;
        context += `${speaker}: ${msg.content}\n`;
    });
    
    context += "\n=== USER INFORMATION ===\n";
    if (memory.userInfo.version) context += `Game Version: ${memory.userInfo.version}\n`;
    if (memory.userInfo.loader) context += `Mod Loader: ${memory.userInfo.loader}\n`;
    if (memory.userInfo.issues.length > 0) context += `Reported Issues: ${memory.userInfo.issues.join(', ')}\n`;
    
    if (memory.solveAttempts.length > 0) {
        context += "\n=== PREVIOUS SOLUTIONS ATTEMPTED ===\n";
        memory.solveAttempts.forEach((attempt, i) => {
            context += `${i + 1}. ${attempt}\n`;
        });
    }
    
    return context;
}

/**
 * Analyze message to understand conversation dynamics and who's being addressed
 * Gets full user context: username, display name, nickname
 */
async function analyzeConversationDynamics(message) {
    const mentions = Array.from(message.mentions.users.values());
    const mentionsBot = message.mentions.has(message.client.user);
    const isDev = DEV_IDS.includes(message.author.id);
    const isKewz = message.author.id === OWNER_ID;
    const isPunchyMan = message.author.id === PUNCHYMAN_ID;
    
    // Get full author info
    let authorInfo = {
        username: message.author.username,
        displayName: message.author.displayName || message.author.username,
        nickname: null,
        isDev: isDev,
        isKewz: isKewz,
        isPunchyMan: isPunchyMan
    };
    
    // Try to get nickname from guild member
    try {
        if (message.guild && message.member) {
            authorInfo.nickname = message.member.nickname;
        }
    } catch (e) {
        // Ignore if we can't get member info
    }
    
    // Analyze mentioned users - check BOTH user IDs AND display names/nicknames
    const mentionedUsers = [];
    let mentionsPunchyMan = false;
    let mentionsOP = false;
    
    for (const user of mentions) {
        if (user.id === message.client.user.id) continue; // Skip bot itself
        
        const userInfo = {
            id: user.id,
            username: user.username,
            displayName: user.displayName || user.username,
            nickname: null,
            isDev: DEV_IDS.includes(user.id),
            isPunchyMan: user.id === PUNCHYMAN_ID
        };
        
        // Try to get nickname
        try {
            if (message.guild) {
                const member = await message.guild.members.fetch(user.id);
                if (member) userInfo.nickname = member.nickname;
            }
        } catch (e) {
            // Ignore if we can't fetch member
        }
        
        if (userInfo.isPunchyMan) mentionsPunchyMan = true;
        mentionedUsers.push(userInfo);
    }
    
    // ALSO check if "Punchy Man" or "PunchyMan" is mentioned in text (even without @mention)
    const contentLower = message.content.toLowerCase();
    if ((contentLower.includes('punchy man') || contentLower.includes('punchyman')) && !mentionsPunchyMan) {
        // They're talking ABOUT PunchyMan (the developer)
        mentionsPunchyMan = 'mentioned_in_text';
    }
    
    // Check if replying to someone (possibly the OP)
    if (message.reference) {
        try {
            const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
            if (repliedMsg && repliedMsg.author.id !== message.author.id) {
                mentionsOP = true;
            }
        } catch (e) {
            // Ignore if we can't fetch the replied message
        }
    }
    
    // Determine conversation type
    let conversationType = 'DIRECT_TO_BOT';
    let contextNote = '';
    
    if (mentionsBot && mentionedUsers.length > 0) {
        // Tagging bot AND other people
        if (isKewz && mentionsPunchyMan) {
            conversationType = 'DEV_COLLABORATION';
            contextNote = 'kewz. is discussing with both you (Shubba) and PunchyMan (the co-developer). This is a dev conversation between the two owners.';
        } else {
            conversationType = 'BRINGING_IN_USER';
            const others = mentionedUsers.map(u => u.nickname || u.displayName).join(', ');
            contextNote = `${authorInfo.nickname || authorInfo.displayName} is bringing ${others} into the conversation with you.`;
        }
    } else if (mentionedUsers.length > 0 && !mentionsBot) {
        conversationType = 'TALKING_TO_OTHERS';
        const others = mentionedUsers.map(u => u.nickname || u.displayName).join(', ');
        contextNote = `${authorInfo.nickname || authorInfo.displayName} is talking to ${others}, not addressing you directly.`;
    } else if (mentionsBot) {
        conversationType = 'DIRECT_TO_BOT';
        contextNote = `${authorInfo.nickname || authorInfo.displayName} is talking directly to you.`;
    }
    
    return {
        conversationType,
        contextNote,
        author: authorInfo,
        mentionedUsers,
        mentionsBot,
        mentionsPunchyMan,
        mentionsOP
    };
}

function extractUserInfo(threadId, content) {
    const memory = getThreadMemory(threadId);
    const contentLower = content.toLowerCase();
    
    TAG_CATEGORIES.VERSIONS.forEach(v => {
        if (contentLower.includes(v.toLowerCase())) {
            memory.userInfo.version = v;
        }
    });
    
    TAG_CATEGORIES.LOADERS.forEach(l => {
        if (contentLower.includes(l.toLowerCase())) {
            memory.userInfo.loader = l;
        }
    });
    
    const issueKeywords = {
        'crash': 'Crashing',
        'visual': 'Visual Bug',
        'animation': 'Animation Issue',
        'compatibility': 'Mod Compatibility',
        'performance': 'Performance Issue'
    };
    
    Object.entries(issueKeywords).forEach(([keyword, issue]) => {
        if (contentLower.includes(keyword) && !memory.userInfo.issues.includes(issue)) {
            memory.userInfo.issues.push(issue);
        }
    });
}

function cleanupOldMemories() {
    const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    
    Object.keys(threadMemory).forEach(threadId => {
        if (now - threadMemory[threadId].lastUpdateTime > ONE_WEEK) {
            delete threadMemory[threadId];
        }
    });
}

setInterval(cleanupOldMemories, 6 * 60 * 60 * 1000);

// --- 4. KNOWLEDGE BASE FUNCTIONS ---

/**
 * Fetch latest versions from Modrinth API
 */
async function fetchModrinthVersions() {
    try {
        console.log("📦 Fetching latest Punchy versions from Modrinth...");
        
        const response = await axios.get(
            `${MODRINTH_API_BASE}/project/${MODRINTH_PROJECT_ID}/version`,
            { 
                timeout: 10000,
                headers: {
                    'User-Agent': 'Shubba-Bot/2.0 (Discord Support Bot)'
                }
            }
        );
        
        // Group versions by MC version and loader
        const versionMap = {};
        const supportedVersions = ['1.20.1', '1.21.1', '1.21.5', '1.21.11'];
        const supportedLoaders = ['fabric', 'forge', 'neoforge'];
        
        response.data.forEach(version => {
            // Extract MC versions and loaders from version
            const gameVersions = version.game_versions || [];
            const loaders = version.loaders || [];
            
            gameVersions.forEach(mcVersion => {
                if (supportedVersions.includes(mcVersion)) {
                    loaders.forEach(loader => {
                        const loaderLower = loader.toLowerCase();
                        if (supportedLoaders.includes(loaderLower)) {
                            const key = `${mcVersion}-${loaderLower}`;
                            
                            // Store only if we don't have this combo yet (API returns newest first)
                            if (!versionMap[key]) {
                                const file = version.files.find(f => f.primary) || version.files[0];
                                versionMap[key] = {
                                    versionNumber: version.version_number,
                                    versionName: version.name,
                                    filename: file?.filename || 'unknown',
                                    mcVersion: mcVersion,
                                    loader: loaderLower,
                                    datePublished: version.date_published,
                                    changelog: version.changelog || ''
                                };
                            }
                        }
                    });
                }
            });
        });
        
        LATEST_VERSIONS = versionMap;
        
        // Build summary
        let summary = "✅ Loaded latest versions:\n";
        Object.entries(versionMap).forEach(([key, info]) => {
            summary += `  - ${info.filename} (${info.versionName})\n`;
        });
        console.log(summary);
        
        return versionMap;
    } catch (e) {
        console.error("⚠️ Failed to fetch Modrinth versions:", e.message);
        return LATEST_VERSIONS; // Return cached versions if fetch fails
    }
}

/**
 * Check if user's version is outdated
 */
function checkVersionStatus(userFilename) {
    if (!userFilename) return null;
    
    // Parse user's filename: punchy-2.1-neoforge-1.21.11.jar
    const match = userFilename.match(/punchy-(.+)-(fabric|forge|neoforge)-(\d+\.\d+\.\d+)\.jar/i);
    if (!match) return null;
    
    const [, userVersion, loader, mcVersion] = match;
    const key = `${mcVersion}-${loader.toLowerCase()}`;
    const latest = LATEST_VERSIONS[key];
    
    if (!latest) {
        return {
            isOutdated: false,
            message: `Could not find latest version info for ${mcVersion} on ${loader}`
        };
    }
    
    const isOutdated = userVersion !== latest.versionNumber;
    
    return {
        isOutdated,
        userVersion,
        latestVersion: latest.versionNumber,
        latestFilename: latest.filename,
        message: isOutdated 
            ? `⚠️ **Outdated Version Detected!**\nYou're using: \`${userFilename}\`\nLatest version: \`${latest.filename}\`\n\nPlease update to the latest version as many issues are fixed in newer releases.`
            : `✅ You're using the latest version: \`${userFilename}\``
    };
}

/**
 * Extract Punchy version from log content
 */
function extractPunchyVersion(logContent) {
    // Look for patterns like:
    // - Loading mod file punchy-2.1-neoforge-1.21.11.jar
    // - punchy-2.0-fabric-1.21.1.jar
    const patterns = [
        /punchy-[\d.]+-(?:fabric|forge|neoforge)-[\d.]+\.jar/gi,
        /Loading.*punchy.*\.jar/gi,
        /punchy.*version.*[\d.]+/gi
    ];
    
    for (const pattern of patterns) {
        const matches = logContent.match(pattern);
        if (matches && matches.length > 0) {
            // Extract just the filename
            const filenameMatch = matches[0].match(/punchy-[\d.]+-(?:fabric|forge|neoforge)-[\d.]+\.jar/i);
            if (filenameMatch) {
                return filenameMatch[0];
            }
        }
    }
    
    return null;
}

/**
 * Fetch log content from hosting platforms
 * Supports: mclo.gs, pastebin.com, paste.ee, hastebin, etc.
 */
async function fetchLogFromUrl(url) {
    try {
        console.log(`📄 Fetching log from: ${url}`);
        
        let fetchUrl = url;
        
        // mclo.gs - https://mclo.gs/XXXXXX or https://api.mclo.gs/1/raw/XXXXXX
        if (url.includes('mclo.gs')) {
            const logId = url.split('/').pop();
            fetchUrl = `https://api.mclo.gs/1/raw/${logId}`;
        }
        // Pastebin - https://pastebin.com/XXXXXX
        else if (url.includes('pastebin.com') && !url.includes('/raw/')) {
            const logId = url.split('/').pop();
            fetchUrl = `https://pastebin.com/raw/${logId}`;
        }
        // Paste.ee - https://paste.ee/p/XXXXXX
        else if (url.includes('paste.ee') && !url.includes('/r/')) {
            const logId = url.split('/').pop();
            fetchUrl = `https://paste.ee/r/${logId}`;
        }
        // Hastebin/Toptal - https://hastebin.com/XXXXXX
        else if (url.includes('hastebin.com') || url.includes('toptal.com/developers/hastebin')) {
            const logId = url.split('/').pop().replace('.txt', '');
            fetchUrl = `https://hastebin.com/raw/${logId}`;
        }
        // GitHub Gist - https://gist.github.com/user/XXXXXX
        else if (url.includes('gist.github.com')) {
            if (!url.includes('/raw/')) {
                fetchUrl = url + '/raw';
            }
        }
        
        const response = await axios.get(fetchUrl, {
            timeout: 30000,
            maxContentLength: 50 * 1024 * 1024, // 50MB max
            headers: {
                'User-Agent': 'Shubba-Bot/2.0 (Discord Support Bot)'
            }
        });
        
        console.log(`✅ Fetched log: ${response.data.length} characters`);
        return response.data;
    } catch (e) {
        console.error(`⚠️ Failed to fetch log from ${url}:`, e.message);
        return null;
    }
}

/**
 * Extract log URLs from message content
 */
function extractLogUrls(content) {
    const logPlatforms = [
        /https?:\/\/mclo\.gs\/[a-zA-Z0-9]+/gi,
        /https?:\/\/(www\.)?pastebin\.com\/[a-zA-Z0-9]+/gi,
        /https?:\/\/paste\.ee\/p\/[a-zA-Z0-9]+/gi,
        /https?:\/\/(www\.)?hastebin\.com\/[a-zA-Z0-9]+/gi,
        /https?:\/\/gist\.github\.com\/[a-zA-Z0-9\-_]+\/[a-fA-F0-9]+/gi,
    ];
    
    const urls = [];
    for (const pattern of logPlatforms) {
        const matches = content.match(pattern);
        if (matches) {
            urls.push(...matches);
        }
    }
    
    return urls;
}

/**
 * Store solution from solved thread
 */
async function storeSolution(thread) {
    try {
        console.log(`💾 Storing solution from solved thread: ${thread.name}`);
        
        // Fetch all messages from the thread
        const messages = await thread.messages.fetch({ limit: 50 });
        const messageArray = Array.from(messages.values()).reverse();
        
        // Extract conversation
        const conversation = messageArray.map(m => 
            `${m.author.username}: ${m.content.substring(0, 500)}`
        ).join('\n');
        
        // Extract user's issue (first message)
        const firstMessage = messageArray[0];
        const issue = firstMessage?.content.substring(0, 300) || "Unknown issue";
        
        // Extract versions from thread tags
        const tags = thread.appliedTags.map(tagId => 
            thread.parent.availableTags.find(t => t.id === tagId)?.name
        ).filter(Boolean);
        
        const solution = {
            threadName: thread.name,
            issue: issue,
            tags: tags,
            conversation: conversation,
            solvedDate: new Date().toISOString(),
            threadId: thread.id,
            version: CURRENT_VERSION_SET
        };
        
        // Ensure current version array exists
        if (!SOLUTIONS_BY_VERSION[CURRENT_VERSION_SET]) {
            SOLUTIONS_BY_VERSION[CURRENT_VERSION_SET] = [];
        }
        
        // Add to current version's solutions array
        SOLUTIONS_BY_VERSION[CURRENT_VERSION_SET].unshift(solution);
        
        // Keep only last MAX_SOLUTIONS_PER_VERSION for current version
        if (SOLUTIONS_BY_VERSION[CURRENT_VERSION_SET].length > MAX_SOLUTIONS_PER_VERSION) {
            SOLUTIONS_BY_VERSION[CURRENT_VERSION_SET] = SOLUTIONS_BY_VERSION[CURRENT_VERSION_SET].slice(0, MAX_SOLUTIONS_PER_VERSION);
        }
        
        // Save to Google Cloud Storage
        await saveSolutionsToGCS();
        
        console.log(`✅ Solution stored for version ${CURRENT_VERSION_SET}. Total: ${SOLUTIONS_BY_VERSION[CURRENT_VERSION_SET].length}`);
        
    } catch (e) {
        console.error("⚠️ Failed to store solution:", e.message);
    }
}

/**
 * Build solutions knowledge base (uses current version's solutions)
 */
function buildSolutionsKnowledge() {
    const currentSolutions = SOLUTIONS_BY_VERSION[CURRENT_VERSION_SET] || [];
    
    if (currentSolutions.length === 0) return "";
    
    let knowledge = `\n--- SOLVED SOLUTIONS DATABASE (Version ${CURRENT_VERSION_SET}) ---\n`;
    knowledge += `(${currentSolutions.length} solutions for version ${CURRENT_VERSION_SET})\n\n`;
    
    currentSolutions.forEach((solution, index) => {
        knowledge += `[Solution ${index + 1}] ${solution.threadName}\n`;
        knowledge += `Tags: ${solution.tags.join(', ')}\n`;
        knowledge += `Issue: ${solution.issue}\n`;
        knowledge += `Resolution:\n${solution.conversation.substring(0, 1000)}\n`;
        knowledge += `---\n`;
    });
    
    return knowledge;
}

async function fetchWikiPage(pageName, langCode = 'EN-US', retryCount = 0) {
    try {
        // Build URL with language code: /wiki/punchy-mod/punchy-wiki/LANG-CODE/PageName-LANG-CODE.md
        const pageFileName = `${pageName}-${langCode}.md`;
        const url = `${WIKI_BASE_URL}${langCode}/${pageFileName}`;
        
        console.log(`Fetching: ${url} (attempt ${retryCount + 1})`);
        
        const response = await axios.get(url, { 
            timeout: 30000, // 30 seconds for large wiki pages
            validateStatus: (status) => status === 200
        });
        
        console.log(`✅ Successfully fetched: ${pageFileName} (${response.data.length} chars)`);
        return { name: pageName, content: response.data, langCode: langCode };
    } catch (e) {
        // Retry up to 2 times on timeout
        if ((e.code === 'ECONNABORTED' || e.message.includes('timeout')) && retryCount < 2) {
            console.log(`⏳ Timeout on ${pageName}, retrying... (${retryCount + 1}/2)`);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
            return fetchWikiPage(pageName, langCode, retryCount + 1);
        }
        
        console.log(`⚠️ Failed to fetch wiki page: ${pageName} (${langCode}) - ${e.message}`);
        return null;
    }
}

async function getFreshKnowledge(forceRefresh = false, langCode = 'EN-US') {
    const now = Date.now();
    
    // Check if we have cached knowledge for this language
    if (!forceRefresh && DYNAMIC_KNOWLEDGE_CACHE[langCode]) {
        const cached = DYNAMIC_KNOWLEDGE_CACHE[langCode];
        if (now - cached.time < KNOWLEDGE_CACHE_DURATION) {
            console.log(`📦 Using cached knowledge (${langCode})`);
            return cached.content;
        }
    }
    
    console.log(`🔍 Fetching fresh knowledge (${langCode})...`);
    let knowledgeBuffer = `PUNCHY MOD KNOWLEDGE BASE (REAL-TIME) - Language: ${langCode}\n\n`;

    // 1. Modrinth Latest Versions
    await fetchModrinthVersions();
    knowledgeBuffer += "--- LATEST PUNCHY VERSIONS (MODRINTH) ---\n";
    Object.entries(LATEST_VERSIONS).forEach(([key, info]) => {
        knowledgeBuffer += `${info.mcVersion} | ${info.loader.toUpperCase()} | ${info.filename} | Version: ${info.versionNumber}\n`;
    });
    knowledgeBuffer += "\n";

    // 2. Discord Channels (only for EN-US to avoid confusion)
    if (langCode === 'EN-US') {
        try {
            const channels = [FAQ_CHANNEL_ID, KNOWN_ISSUES_ID];
            for (const id of channels) {
                const channel = await client.channels.fetch(id);
                const messages = await channel.messages.fetch({ limit: 40 });
                knowledgeBuffer += `--- DISCORD INFO FROM #${channel.name} ---\n`;
                messages.reverse().forEach(m => { 
                    if(m.content && !m.author.bot) knowledgeBuffer += `- ${m.content}\n` 
                });
                knowledgeBuffer += "\n";
            }
        } catch (e) { 
            console.log("⚠️ Discord fetch error:", e.message); 
        }
    }

    // 3. GitHub Wiki Pages - fetch in the specified language
    console.log(`📚 Fetching wiki pages (${langCode})...`);
    let successCount = 0;
    
    for (const page of WIKI_PAGES) {
        const result = await fetchWikiPage(page, langCode);
        if (result && result.content) {
            knowledgeBuffer += `--- WIKI PAGE: ${result.name} (${langCode}) ---\n${result.content}\n\n`;
            successCount++;
        }
        // Small delay between pages to be nice to GitHub's servers
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`✅ Successfully loaded ${successCount}/${WIKI_PAGES.length} wiki pages (${langCode})`);
    
    // If no pages loaded in this language, fall back to English
    if (successCount === 0 && langCode !== 'EN-US') {
        console.log(`⚠️ No wiki pages found in ${langCode}, falling back to EN-US`);
        for (const page of WIKI_PAGES) {
            const result = await fetchWikiPage(page, 'EN-US');
            if (result && result.content) {
                knowledgeBuffer += `--- WIKI PAGE: ${result.name} (EN-US fallback) ---\n${result.content}\n\n`;
                successCount++;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    // 4. Trello Board (only for EN-US)
    if (langCode === 'EN-US') {
        try {
            const listsResponse = await axios.get(
                `https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/lists?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
                { timeout: 10000 }
            );
            const cardsResponse = await axios.get(
                `https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/cards?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
                { timeout: 10000 }
            );
            
            const listsMap = {};
            listsResponse.data.forEach(l => listsMap[l.id] = l.name);
            knowledgeBuffer += `--- TRELLO PROJECT BOARD STATUS ---\n`;
            cardsResponse.data.forEach(card => { 
                const listName = listsMap[card.idList] || "Unknown";
                knowledgeBuffer += `[List: ${listName}] - Task: ${card.name} | Desc: ${card.desc || "No desc"}\n`;
            });
        } catch (e) { 
            console.log("⚠️ Trello fetch error:", e.message); 
        }
    }

    // 5. Solved Solutions Database (only for EN-US)
    if (langCode === 'EN-US') {
        knowledgeBuffer += buildSolutionsKnowledge();
    }

    // Cache the knowledge for this language
    DYNAMIC_KNOWLEDGE_CACHE[langCode] = {
        content: knowledgeBuffer,
        time: now
    };
    
    console.log(`✅ Fresh knowledge cached (${langCode})!`);
    return knowledgeBuffer;
}

async function studyEverything() {
    console.log("🧠 Background study session starting...");
    
    try {
        await getFreshKnowledge(true);
        
        const forum = await client.channels.fetch(SUPPORT_FORUM_ID);
        const activeThreads = await forum.threads.fetchActive();
        const archivedThreads = await forum.threads.fetchArchived({ limit: 15 });
        const allThreads = [...activeThreads.threads.values(), ...archivedThreads.threads.values()].slice(0, 15);
        
        let caseStudies = `\n--- CASE STUDIES: HOW PAST THREADS WERE HANDLED ---\n`;
        const caseResults = await Promise.all(allThreads.map(async (thread) => {
            try {
                const messages = await thread.messages.fetch({ limit: 10 });
                const chatLog = messages.reverse().map(m => `${m.author.username}: ${m.content.substring(0, 150)}`).join("\n");
                return `[Case: ${thread.name}]\nDialogue:\n${chatLog}\n\n`;
            } catch (e) {
                return `[Case: ${thread.name}]\n(Could not fetch messages)\n\n`;
            }
        }));
        caseStudies += caseResults.join('');
        
        // Add case studies to EN-US cache
        if (DYNAMIC_KNOWLEDGE_CACHE['EN-US']) {
            DYNAMIC_KNOWLEDGE_CACHE['EN-US'].content += caseStudies;
        }
        
        console.log("✅ Background study complete!");
    } catch (e) {
        console.error("⚠️ Study error:", e.message);
        // Don't crash - just log the error
    }
}

// --- 4. SLASH COMMANDS ---

const commands = [
    new SlashCommandBuilder()
        .setName('pause_bot')
        .setDescription('Stop Shubba from responding in this thread')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('resume_bot')
        .setDescription('Allow Shubba to respond in this thread again')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('summary')
        .setDescription('Summarize everything going on in this post')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('solve')
        .setDescription('Mark post as solved, lock it, and archive it')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('restart')
        .setDescription('Restart the bot process')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('memory')
        .setDescription('View what Shubba remembers about this thread')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('refresh_knowledge')
        .setDescription('Force refresh the knowledge base')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('test_wiki')
        .setDescription('Test which wiki pages can be fetched')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('versions')
        .setDescription('View latest Punchy versions from Modrinth')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('solutions')
        .setDescription('View stored solutions database')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
    try {
        console.log(`⏳ Started refreshing ${commands.length} application (/) commands.`);
        if (DEV_GUILD_ID) {
            await rest.put(Routes.applicationGuildCommands(CLIENT_ID, DEV_GUILD_ID), { body: commands });
            await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
            console.log('✅ Registered GUILD commands and WIPED GLOBAL commands.');
        } else {
            await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
            console.log('✅ Successfully reloaded Global commands.');
        }
    } catch (error) { console.error('❌ Error registering slash commands:', error); }
}

// --- 5. HELPERS ---

function splitMessage(text, limit = 1900) {
    const chunks = [];
    let current = text;
    while (current.length > 0) {
        if (current.length <= limit) {
            chunks.push(current);
            break;
        }
        let splitIndex = current.lastIndexOf('\n', limit);
        if (splitIndex === -1) splitIndex = limit;
        chunks.push(current.substring(0, splitIndex));
        current = current.substring(splitIndex).trim();
    }
    return chunks;
}

async function analyzeAttachments(message, threadId) {
    let details = "";
    let logContent = "";
    let hasVideo = false;
    const memory = getThreadMemory(threadId);

    // First, check for log URLs in the message content
    const logUrls = extractLogUrls(message.content);
    if (logUrls.length > 0) {
        details += `- Found ${logUrls.length} log URL(s)\n`;
        for (const url of logUrls) {
            const fetchedLog = await fetchLogFromUrl(url);
            if (fetchedLog) {
                logContent += `\n--- START OF LOG FROM: ${url} ---\n${fetchedLog.substring(0, 50000)}\n--- END OF LOG ---\n`;
                memory.hasLog = true;
            }
        }
    }

    // Then check attachments
    for (const attachment of message.attachments.values()) {
        const nameLower = attachment.name.toLowerCase();
        const contentType = attachment.contentType || "";
        details += `- Attached: ${attachment.name}\n`;
        
        memory.attachments.push({
            name: attachment.name,
            url: attachment.url,
            type: contentType,
            timestamp: Date.now()
        });
        
        if (contentType.startsWith('video/') || nameLower.endsWith('.mp4') || nameLower.endsWith('.mov') || nameLower.endsWith('.webm')) {
            hasVideo = true;
        }

        const isLog = nameLower.includes('log') || nameLower.includes('crash');
        const isModlist = nameLower.includes('mod') || nameLower.includes('lista');
        if (isLog) memory.hasLog = true;
        if (isModlist) memory.hasModlist = true;

        if (contentType.startsWith('text/') || isLog || isModlist) {
            try {
                const response = await axios.get(attachment.url, { 
                    responseType: 'arraybuffer',
                    timeout: 30000,
                    maxContentLength: 50 * 1024 * 1024
                });
                const buffer = Buffer.from(response.data);
                let text;
                if (buffer.length >= 2 && ((buffer[0] === 0xFF && buffer[1] === 0xFE) || (buffer[0] === 0xFE && buffer[1] === 0xFF))) {
                    text = buffer.toString('utf16le');
                } else if (buffer.includes(0x00)) {
                    text = buffer.toString('utf16le');
                } else {
                    text = buffer.toString('utf8');
                }
                logContent += `\n--- START OF FILE: ${attachment.name} ---\n${text.substring(0, 50000)}\n--- END OF FILE ---\n`;
            } catch (e) { 
                console.log(`⚠️ Failed to read attachment: ${attachment.name}`, e.message);
                logContent += `\n--- FILE: ${attachment.name} (Failed to read: ${e.message}) ---\n`;
            }
        }
    }
    return { details, logContent, hasVideo };
}

async function applyTagsFromText(message, thread) {
    const content = message.content.toLowerCase();
    const availableTags = thread.parent.availableTags;
    const currentTags = new Set(thread.appliedTags);
    let changed = false;

    const loaders = ['fabric', 'neoforge', 'forge'];
    loaders.forEach(l => {
        if (content.includes(l)) {
            const tag = availableTags.find(t => t.name.toLowerCase() === l);
            if (tag && !currentTags.has(tag.id)) { currentTags.add(tag.id); changed = true; }
        }
    });

    const versions = TAG_CATEGORIES.VERSIONS;
    versions.forEach(v => {
        if (content.includes(v)) {
            const tag = availableTags.find(t => t.name === v);
            if (tag && !currentTags.has(tag.id)) { currentTags.add(tag.id); changed = true; }
        }
    });

    if (content.includes('crash') || content.includes('crashing')) {
        const tag = availableTags.find(t => t.name.toLowerCase().includes('crash'));
        if (tag && !currentTags.has(tag.id)) { currentTags.add(tag.id); changed = true; }
    }
    if (changed) await thread.setAppliedTags([...currentTags]).catch(() => {});
}

async function requestHumanHelp(thread, reason) {
    if (thread.name.startsWith('(HUMAN HELP)')) return;
    try {
        await thread.setName(`(HUMAN HELP) ${thread.name.replace('[SOLVED] ', '')}`);
        const pings = DEV_IDS.map(id => `<@${id}>`).join(' ');
        const isWikiForum = thread.parentId === WIKI_FORUM_ID;
        const helpType = isWikiForum ? "Wiki question needs human help" : "Support issue needs human help";
        await thread.send({ content: `🚩 **Human Help Requested!**\n${helpType}\nReason: ${reason}\n\nAttention: ${pings}\n\nI'll step aside for a human moderator. I won't reply anymore unless tagged!` });
    } catch (e) { console.error("Failed to flag thread:", e); }
}

async function solveThread(thread, interactionOrMessage) {
    try {
        const isWikiForum = thread.parentId === WIKI_FORUM_ID;
        
        // Only store solution if it's from support forum (not wiki forum)
        if (!isWikiForum) {
            await storeSolution(thread);
        }
        
        const cleanName = thread.name.replace('(HUMAN HELP) ', '').replace('[SOLVED] ', '');
        const newName = `[SOLVED] ${cleanName}`;
        const msg = isWikiForum 
            ? "✅ **Answered!** This wiki question is now being locked and archived. If you have more questions, please create a new post!"
            : "✅ **Solved!** This thread is now being locked and archived. If you need further assistance, please create a new post!";
        
        // Send confirmation message - handle interaction expiration
        let confirmationSent = false;
        
        if (interactionOrMessage.editReply) {
            // This is a deferred interaction - might have expired
            try {
                await interactionOrMessage.editReply({ content: msg });
                confirmationSent = true;
            } catch (e) {
                if (e.code === 10062) {
                    console.log("⚠️ Interaction expired, sending message instead");
                    await thread.send({ content: msg });
                    confirmationSent = true;
                } else {
                    throw e;
                }
            }
        } else if (interactionOrMessage.reply && !interactionOrMessage.author) {
            // This is a fresh interaction
            try {
                await interactionOrMessage.reply({ content: msg, ephemeral: false });
                confirmationSent = true;
            } catch (e) {
                if (e.code === 10062) {
                    console.log("⚠️ Interaction expired, sending message instead");
                    await thread.send({ content: msg });
                    confirmationSent = true;
                } else {
                    await thread.send({ content: msg });
                    confirmationSent = true;
                }
            }
        } else {
            // This is a regular message
            await thread.send({ content: msg });
            confirmationSent = true;
        }

        // Rename, lock, and archive the thread
        await thread.setName(newName);
        await thread.setLocked(true, "Thread marked as solved.");
        await thread.setArchived(true);
        
        delete threadMemory[thread.id];
        
        console.log(`✅ Thread solved: ${newName} (${isWikiForum ? 'Wiki' : 'Support'})`);
    } catch (e) {
        console.error("❌ Error solving thread:", e);
        const errMsg = "⚠️ Failed to complete all solve actions. Check my permissions (Manage Threads).";
        
        try {
            // Try to send error message, but don't crash if it fails
            if (interactionOrMessage.editReply) {
                await interactionOrMessage.editReply({ content: errMsg }).catch(() => {});
            } else if (interactionOrMessage.followUp) {
                await interactionOrMessage.followUp({ content: errMsg, flags: [MessageFlags.Ephemeral] }).catch(() => {});
            } else {
                await thread.send({ content: errMsg }).catch(() => {});
            }
        } catch (err) {
            console.error("Failed to send error message:", err.message);
        }
    }
}

function getSupportButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('request_human_help').setLabel('🙋 Request Human Help').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('mark_as_solved').setLabel('✅ Mark As Solved').setStyle(ButtonStyle.Primary)
    );
}

/**
 * Quality check and fix Shubba's response before sending
 * Fixes: JSON formatting, broken links, markdown issues
 */
function qualityCheckResponse(text, langCode = 'EN-US') {
    let fixed = text;
    
    // 1. Fix JSON code blocks - ensure proper formatting
    fixed = fixed.replace(/```json\s*\n?\s*{/g, '```json\n{');
    fixed = fixed.replace(/}\s*\n?\s*```/g, '\n}```');
    
    // 2. Fix broken wiki links - remove markdown syntax around angle bracket URLs
    // Bad: [text](<url>) → Good: text: <url>
    fixed = fixed.replace(/\[([^\]]+)\]\(<(https:\/\/github\.com\/punchy-mod\/punchy-wiki\/wiki\/[^>]+)>\)/g, '$1: <$2>');
    
    // 3. Ensure wiki links have proper language suffix
    fixed = fixed.replace(/<(https:\/\/github\.com\/punchy-mod\/punchy-wiki\/wiki\/([^>]+))>/g, (match, url, pageName) => {
        // Check if it already has a language suffix
        if (!pageName.endsWith(`-${langCode}`)) {
            // Add language suffix if missing
            return `<${url}-${langCode}>`;
        }
        return match;
    });
    
    // 4. Fix numbered lists that might be broken
    fixed = fixed.replace(/(\d+)\.\s*\n\s*"(\w+)":/g, '$1. "$2":');
    
    // 5. Clean up excessive newlines (more than 2 in a row)
    fixed = fixed.replace(/\n{3,}/g, '\n\n');
    
    // 6. Fix code blocks that are missing language specifier
    fixed = fixed.replace(/```\s*\n\s*{/g, '```json\n{');
    
    // 7. Ensure proper spacing around code blocks
    fixed = fixed.replace(/([^\n])```/g, '$1\n```');
    fixed = fixed.replace(/```([^\n])/g, '```\n$1');
    
    console.log('✅ Response quality checked and cleaned');
    return fixed;
}

/**
 * Validate that all wiki links in response are properly formatted
 */
function validateWikiLinks(text) {
    const wikiLinkPattern = /<(https:\/\/github\.com\/punchy-mod\/punchy-wiki\/wiki\/[^>]+)>/g;
    const links = text.match(wikiLinkPattern) || [];
    
    const issues = [];
    links.forEach((link, index) => {
        // Check if link has language code
        if (!link.match(/-(?:EN-US|DE-DE|ES-ES|FR-FR|JA-JP|PT-BR|RU-RU|ZH-CN)>/)) {
            issues.push(`Link ${index + 1} missing language code: ${link}`);
        }
        
        // Check if link uses angle brackets (to suppress embeds)
        if (link.startsWith('[') || link.includes('](')) {
            issues.push(`Link ${index + 1} not using angle brackets: ${link}`);
        }
    });
    
    if (issues.length > 0) {
        console.warn('⚠️ Wiki link issues found:', issues);
    }
    
    return issues.length === 0;
}

function processAiVisuals(text) {
    const imgRegex = /(https?:\/\/.*\.(?:png|jpg|jpeg|gif|webp))/gi;
    const matches = text.match(imgRegex) || [];
    const attachments = matches.map(url => new AttachmentBuilder(url));
    return { cleanText: text, attachments };
}

// --- 6. BOT LOGIC ---

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
});

// ERROR HANDLER - Prevent crashes from unhandled errors
client.on('error', (error) => {
    console.error('❌ Discord Client Error:', error.message);
    // Don't crash the bot - just log the error
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled Promise Rejection:', error);
    // Don't crash the bot - just log the error
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅ Success! Bot is online as ${readyClient.user.tag}`);
  console.log(`💎 Running with PAID TIER rate limits (500 RPM)`);
  console.log(`🎬 Teaser video hosting enabled for channel: ${TEASERS_CHANNEL_ID}`);
  
  // Load solutions from Google Cloud Storage
  await loadSolutionsFromGCS();
  
  await registerCommands();
  await studyEverything();
});

setInterval(studyEverything, 60 * 60 * 1000);

client.on(Events.ThreadCreate, async (thread) => {
  // Handle support forum
  if (thread.parentId === SUPPORT_FORUM_ID && !managedThreads.has(thread.id)) {
    managedThreads.add(thread.id);
    console.log(`📌 New support thread created: ${thread.name} (ID: ${thread.id})`);
    
    setTimeout(async () => {
      try {
        const starter = await thread.fetchStarterMessage();
        if (!starter) {
            console.error(`⚠️ Could not fetch starter message for thread: ${thread.name}`);
            return;
        }
        
        if (processingThreads.has(thread.id)) {
            console.log(`⏭️ Thread ${thread.id} already being processed, skipping`);
            return;
        }
        
        processingThreads.add(thread.id);
        console.log(`🔄 Processing support thread: ${thread.name}`);
        await thread.sendTyping();
        
        addToThreadMemory(thread.id, starter.author.username, starter.content, false);
        extractUserInfo(thread.id, starter.content);
        
        await applyTagsFromText(starter, thread); 
        const { details, logContent, hasVideo } = await analyzeAttachments(starter, thread.id);
        if (hasVideo) { 
            processingThreads.delete(thread.id); 
            return await requestHumanHelp(thread, "Video detected."); 
        }
        
        // Check for Punchy version in message or log
        let detectedVersion = null;
        let versionWarning = "";
        
        // Try to extract version from log first
        if (logContent) {
            detectedVersion = extractPunchyVersion(logContent);
        }
        
        // If not in log, check message content
        if (!detectedVersion) {
            const filenameMatch = starter.content.match(/punchy-[\d.]+-(?:fabric|forge|neoforge)-[\d.]+\.jar/i);
            if (filenameMatch) {
                detectedVersion = filenameMatch[0];
            }
        }
        
        // Check version status
        if (detectedVersion) {
            const versionStatus = checkVersionStatus(detectedVersion);
            if (versionStatus && versionStatus.isOutdated) {
                versionWarning = "\n\n" + versionStatus.message;
            }
        }
        
        const freshKnowledge = await getFreshKnowledge();
        const tags = thread.appliedTags.map(tagId => thread.parent.availableTags.find(t => t.id === tagId)?.name || "Unknown Tag");
        const conversationContext = buildConversationContext(thread.id);
        
        // AUTO DEEP ANALYSIS: If log content detected, perform deep analysis automatically
        const hasLogFile = logContent.length > 100; // Check if substantial log content exists
        const isDeepAnalysis = hasLogFile;
        
        if (isDeepAnalysis) {
            console.log(`🔍 Auto-triggering deep analysis for thread: ${thread.name}`);
            await thread.send("🔍 **Log file detected! Performing deep technical analysis...**");
        }
        
        const rawAnswer = await askGemini(
            starter.content, 
            thread, 
            tags, 
            details, 
            logContent, 
            checkTagCompliance(tags), 
            conversationContext, 
            freshKnowledge,
            isDeepAnalysis, // Pass deep analysis flag
            detectedVersion // Pass detected version
        );
        
        if (rawAnswer.startsWith("ERROR:")) {
            processingThreads.delete(thread.id);
            return await requestHumanHelp(thread, "AI analysis failed - " + rawAnswer.substring(6));
        }
        
        addToThreadMemory(thread.id, client.user.username, rawAnswer, true);
        
        const { cleanText, attachments } = processAiVisuals(rawAnswer);
        const chunks = splitMessage(cleanText);
        
        // Add report header if deep analysis was performed + version warning
        const firstChunk = isDeepAnalysis 
            ? `📊 **Deep Technical Analysis Report**\n\n${chunks[0]}${versionWarning}`
            : `${chunks[0]}${versionWarning}`;
        
        await thread.send({ content: firstChunk, files: attachments });
        
        for (let i = 1; i < chunks.length - 1; i++) {
            await thread.send(chunks[i]);
        }
        
        if (chunks.length > 1) {
            await thread.send({ content: chunks[chunks.length - 1], components: [getSupportButtons()] });
        } else {
            const messages = await thread.messages.fetch({ limit: 1 });
            const lastMsg = messages.first();
            await lastMsg.edit({ components: [getSupportButtons()] });
        }
        
      } catch (error) { 
          console.error("❌ Support thread create error:", error);
          console.error(`   Thread: ${thread.name} (ID: ${thread.id})`);
          console.error(`   Error details:`, error.stack);
          
          // Try to send error message to thread
          try {
              await thread.send("⚠️ I encountered an error processing this thread. Please mention me with @Shubba if you need help!");
          } catch (e) {
              console.error("   Could not send error message to thread:", e.message);
          }
      } finally { 
          processingThreads.delete(thread.id);
          console.log(`✅ Finished processing support thread: ${thread.name}`);
      }
    }, 4000);
  }
  
  // Handle wiki forum - Shubba becomes wiki expert with multilingual support
  if (thread.parentId === WIKI_FORUM_ID && !managedThreads.has(thread.id)) {
    managedThreads.add(thread.id);
    console.log(`📚 New wiki thread created: ${thread.name} (ID: ${thread.id})`);
    
    setTimeout(async () => {
      try {
        const starter = await thread.fetchStarterMessage();
        if (!starter) {
            console.error(`⚠️ Could not fetch starter message for wiki thread: ${thread.name}`);
            return;
        }
        
        if (processingThreads.has(thread.id)) {
            console.log(`⏭️ Wiki thread ${thread.id} already being processed, skipping`);
            return;
        }
        
        processingThreads.add(thread.id);
        console.log(`🔄 Processing wiki thread: ${thread.name}`);
        await thread.sendTyping();
        
        // Detect language from user's message
        const detectedLang = detectLanguage(starter.content);
        const langInfo = SUPPORTED_LANGUAGES[detectedLang];
        console.log(`🌐 Detected language: ${langInfo.nativeName} (${detectedLang})`);
        
        addToThreadMemory(thread.id, starter.author.username, starter.content, false);
        
        // Fetch knowledge in detected language
        const freshKnowledge = await getFreshKnowledge(false, detectedLang);
        const conversationContext = buildConversationContext(thread.id);
        
        // Build wiki links in the detected language - SUPPRESS EMBEDS with angle brackets
        const wikiLinks = WIKI_PAGES.map(page => {
            const url = `https://github.com/punchy-mod/punchy-wiki/wiki/${page}-${detectedLang}`;
            return `${page.replace(/-/g, ' ')}: <${url}>`; // Angle brackets suppress embeds
        }).join('\n');
        
        // Wiki expert mode - WITH REASONING AND UNDERSTANDING
        const wikiPrompt = `You are Shubba, a knowledgeable wiki expert for the Punchy! Minecraft mod. You've READ and UNDERSTOOD the entire wiki - you don't just copy-paste, you EXPLAIN things in your own words.

IMPORTANT: Respond in ${langInfo.name} (${langInfo.nativeName}).

USER'S QUESTION: ${starter.content}

THREAD CONTEXT: "${thread.name}"

WIKI KNOWLEDGE (YOU'VE READ AND UNDERSTOOD THIS):
${freshKnowledge.substring(0, 40000)}

AVAILABLE WIKI PAGES (use these URLs with <angle brackets> to prevent Discord embeds):
${wikiLinks}

CRITICAL INSTRUCTIONS - HOW TO BE A GOOD WIKI EXPERT:
1. UNDERSTAND FIRST: Read the wiki content and understand it, don't just copy-paste
2. EXPLAIN IN YOUR OWN WORDS: Rephrase the wiki information naturally, like teaching a friend
3. BE CONVERSATIONAL: Talk naturally, don't sound like documentation
4. ONLY LINK WHEN HELPFUL: If the wiki page has more details, suggest it like: "For more details, check out <URL>"
5. ANSWER DIRECTLY: If you can answer without the wiki page, do it! Only reference wiki when needed
6. BE CONCISE: Don't dump entire wiki sections - extract what matters
7. USE EXAMPLES: When explaining, give practical examples
8. SUPPRESS EMBEDS: Always use <angle brackets> around URLs to prevent Discord embeds

FORMATTING RULES (VERY IMPORTANT):
- JSON code blocks: Use three backticks followed by 'json' with proper indentation
- NO numbered lists inside JSON code blocks
- Wiki links: Format as "Page Name: <URL>" NOT "[Page Name](<URL>)"
- Code blocks: Must have blank lines before and after
- Keep JSON clean and properly formatted

Example GOOD JSON format:
\`\`\`json
{
  "itemSpecific": {
    "minecraft:diamond_sword": {
      "customAnimation": [
        {
          "type": "attack",
          "var_1": "sword_attack_1"
        }
      ]
    }
  }
}
\`\`\`

Example BAD JSON (don't do this):
{
1. "type": "attack"
}

LANGUAGE: Respond entirely in ${langInfo.name}

Example GOOD response:
"To enable better combat, you need to set 'betterCombatCompat' to true in your config file. This makes the mod work smoothly with Better Combat. You can find your config in .minecraft/config/punchy.json. For all the config options, see <https://github.com/punchy-mod/punchy-wiki/wiki/...>"

Example BAD response (don't do this):
"According to the wiki: [copies entire wiki section verbatim]"

Respond as a helpful, knowledgeable expert who UNDERSTANDS the content.`;

        const rawAnswer = await callGemini(wikiPrompt, false); // Wiki questions use flash mode
        
        // Quality check and fix response before sending
        const fixedAnswer = qualityCheckResponse(rawAnswer, detectedLang);
        validateWikiLinks(fixedAnswer); // Log any remaining issues
        
        addToThreadMemory(thread.id, client.user.username, fixedAnswer, true);
        
        const chunks = splitMessage(fixedAnswer);
        const langFlag = detectedLang === 'EN-US' ? '📚' : `🌐 ${langInfo.nativeName}`;
        const firstChunk = `${langFlag} **Wiki Help**\n\n${chunks[0]}`;
        
        await thread.send({ content: firstChunk });
        
        for (let i = 1; i < chunks.length - 1; i++) {
            await thread.send(chunks[i]);
        }
        
        // Add buttons on last message
        if (chunks.length > 1) {
            await thread.send({ content: chunks[chunks.length - 1], components: [getSupportButtons()] });
        } else {
            const messages = await thread.messages.fetch({ limit: 1 });
            const lastMsg = messages.first();
            await lastMsg.edit({ components: [getSupportButtons()] });
        }
        
      } catch (error) { 
          console.error("❌ Wiki thread create error:", error);
          console.error(`   Thread: ${thread.name} (ID: ${thread.id})`);
          console.error(`   Error details:`, error.stack);
          
          // Try to send error message to thread
          try {
              await thread.send("⚠️ I encountered an error processing this wiki question. Please mention me with @Shubba if you need help!");
          } catch (e) {
              console.error("   Could not send error message to thread:", e.message);
          }
      } finally { 
          processingThreads.delete(thread.id);
          console.log(`✅ Finished processing wiki thread: ${thread.name}`);
      }
    }, 4000);
  }
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) {
        // TRELLO BOT INTERCEPTOR - Reformat bug fix announcements
        if (message.channelId === BUG_FIXES_CHANNEL_ID && message.embeds.length > 0) {
            console.log(`🔧 Intercepting ${message.embeds.length} bug fix announcement(s)`);
            
            try {
                const bugFixes = [];
                
                for (const embed of message.embeds) {
                    // Extract bug name from embed
                    const description = embed.description || '';
                    const cardMatch = description.match(/Card:\s*(.+?)(?:\n|$)/i);
                    const currentListMatch = description.match(/Current List:\s*(.+?)(?:\n|$)/i);
                    
                    if (cardMatch && currentListMatch && currentListMatch[1].toLowerCase().includes('bug fixed')) {
                        let bugName = cardMatch[1].trim();
                        
                        // Remove ** artifacts that might come from Trello formatting
                        bugName = bugName.replace(/\*\*/g, '');
                        
                        bugFixes.push(bugName);
                    }
                }
                
                // Send formatted messages (suppress embeds)
                if (bugFixes.length > 0) {
                    for (const bugName of bugFixes) {
                        // Wrap URLs in angle brackets to suppress embed preview
                        let cleanName = bugName;
                        if (bugName.includes('http')) {
                            // If it's a markdown link [text](url), extract just the text
                            const linkMatch = bugName.match(/\[(.+?)\]\((.+?)\)/);
                            if (linkMatch) {
                                cleanName = linkMatch[1]; // Just use the text, not the URL
                            }
                        }
                        
                        await message.channel.send(`🎉 The devs have fixed the bug: **${cleanName}**. It will be released in the next Punchy! update!`);
                    }
                    
                    // Delete the original embed message
                    await message.delete();
                    console.log(`✅ Reformatted ${bugFixes.length} bug fix announcement(s)`);
                }
            } catch (e) {
                console.error("⚠️ Error processing bug fix announcement:", e.message);
            }
        }
        
        return; // Don't process other bot messages
    }

    // ============================================================
    // ✨ NEW: TEASER CHANNEL VIDEO HOSTING
    // ============================================================
    if (message.channelId === TEASERS_CHANNEL_ID) {
        if (message.attachments.size > 0 || /https:\/\/cdn\.discordapp\.com\/attachments\/[^\s]+\.(mp4|mov|webm|mkv|avi|gif)/i.test(message.content)) {
            console.log(`🎬 New message in teasers channel from ${message.author.username}`);
            await handleTeaserMessage(message);
        }
    }
    // ============================================================
    // END TEASER HANDLING
    // ============================================================
    
    // MUSIC CHANNEL AUTO-THREAD CREATOR for ballofgum_
    if (message.channelId === MUSIC_CHANNEL_ID && message.author.id === BALLOFGUM_USER_ID) {
        console.log(`🎵 Checking ballofgum_'s message for music content...`);
        
        try {
            let musicTitle = null;
            let shouldCreateThread = false;
            
            // Check for audio file attachments
            for (const attachment of message.attachments.values()) {
                const nameLower = attachment.name.toLowerCase();
                if (nameLower.endsWith('.mp3') || nameLower.endsWith('.wav') || nameLower.endsWith('.ogg') || nameLower.endsWith('.flac')) {
                    // Extract filename without extension
                    musicTitle = attachment.name.replace(/\.(mp3|wav|ogg|flac)$/i, '');
                    shouldCreateThread = true;
                    break;
                }
            }
            
            // Check for YouTube links if no audio file found
            if (!shouldCreateThread) {
                const youtubeRegex = /(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/;
                const match = message.content.match(youtubeRegex);
                
                if (match) {
                    const videoId = match[4];
                    
                    // Try to get video title from YouTube (using oEmbed API)
                    try {
                        const response = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, {
                            timeout: 5000
                        });
                        musicTitle = response.data.title;
                        shouldCreateThread = true;
                    } catch (e) {
                        // Fallback if we can't get the title
                        musicTitle = "this track";
                        shouldCreateThread = true;
                    }
                }
            }
            
            // Create thread with dynamic title
            if (shouldCreateThread && musicTitle) {
                const threadTitles = [
                    `Thoughts on ${musicTitle}?`,
                    `What do you think of ${musicTitle}?`,
                    `Your take on ${musicTitle}?`,
                    `Opinions on ${musicTitle}?`,
                    `How's ${musicTitle} sounding?`,
                    `Feedback on ${musicTitle}?`
                ];
                
                // Pick a random title
                const threadTitle = threadTitles[Math.floor(Math.random() * threadTitles.length)];
                
                // Create public thread
                const thread = await message.startThread({
                    name: threadTitle,
                    autoArchiveDuration: 1440, // 24 hours
                    reason: 'Auto-created thread for music discussion'
                });
                
                console.log(`✅ Created thread: ${threadTitle}`);
                
                // Optional: Send a welcoming message in the thread
                await thread.send(`🎵 **Discussion thread created!** Share your thoughts on this track here!`);
            }
            
        } catch (e) {
            console.error("⚠️ Error creating music thread:", e.message);
        }
    }
    
    const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator);
    const isOwner = DEV_IDS.includes(message.author.id);
    const isDev = isOwner; // Devs = Owners for this bot
    const isPrimaryOwner = message.author.id === OWNER_ID;
    const contentLower = message.content.toLowerCase();
    // FIX: Properly check for direct bot mentions, excluding @everyone/@here
    const isMentioned = message.mentions.has(client.user) && !message.mentions.everyone;

    // DEV NATURAL LANGUAGE COMMANDS - Use AI to understand intent instead of exact keywords
    if (isDev && message.channel.isThread && message.channel.isThread() && (message.channel.parentId === SUPPORT_FORUM_ID || message.channel.parentId === WIKI_FORUM_ID)) {
        const thread = message.channel;
        
        // Use AI to understand dev intent if message is short and likely a command
        if (isMentioned && message.content.length < 200) {
            try {
                const intentPrompt = `You are analyzing a message from a developer to determine their intent. The developer is in a support thread titled "${thread.name}".

DEVELOPER MESSAGE: "${message.content}"

CONTEXT: The developer has several available actions:
1. PAUSE - Stop the bot from responding (unless mentioned)
2. RESUME - Allow the bot to respond again
3. SOLVE - Mark the thread as solved and close it
4. STATUS_UPDATE - Just acknowledging a fix/update (no action needed)

Respond with ONLY ONE WORD from: PAUSE, RESUME, SOLVE, STATUS_UPDATE, NONE

Examples:
"stop" → PAUSE
"shut up" → PAUSE
"this is solved" → SOLVE
"solve this" → SOLVE
"continue" → RESUME
"this has been fixed" → STATUS_UPDATE
"what's the issue here?" → NONE
"can you help with this?" → NONE`;

                const intent = await callGemini(intentPrompt, false);
                const intentClean = intent.trim().toUpperCase();
                
                console.log(`🧠 Dev intent detected: ${intentClean} from message: "${message.content}"`);
                
                if (intentClean === 'PAUSE') {
                    pausedThreads.add(thread.id);
                    console.log(`⏸️ Dev ${message.author.username} paused thread: ${thread.name}`);
                    await message.reply("⏸️ Got it, I'll stop responding here unless tagged.");
                    return;
                }
                
                if (intentClean === 'SOLVE') {
                    console.log(`✅ Dev ${message.author.username} marking thread as solved: ${thread.name}`);
                    await solveThread(thread, message);
                    return;
                }
                
                if (intentClean === 'RESUME') {
                    pausedThreads.delete(thread.id);
                    console.log(`▶️ Dev ${message.author.username} resumed thread: ${thread.name}`);
                    await message.reply("▶️ Alright, I'm back!");
                    return;
                }
                
                if (intentClean === 'STATUS_UPDATE') {
                    console.log(`✅ Dev ${message.author.username} reported fix in thread: ${thread.name}`);
                    await message.reply(`Noted! 👍`);
                    return;
                }
                
                // If NONE, continue to normal processing
                
            } catch (e) {
                console.error("⚠️ Intent detection error:", e.message);
                // Fall through to normal processing
            }
        }
    }

    // OWNER PRIVILEGES: Owners can talk to Shubba ANYWHERE when they tag him
    if (isOwner && isMentioned) {
        console.log(`👑 Owner ${message.author.username} is talking to Shubba`);

        // ── FAQ POST TRIGGER ──────────────────────────────────────────────────
        if (contentLower.includes('post') && contentLower.includes('faq')) {
            console.log(`📋 Owner ${message.author.username} requested FAQ post`);
            await postFAQ(message);
            return;
        }

        // ── UPLOAD TRIGGER ────────────────────────────────────────────────────
        // If owner attaches a file, pastes a Discord message link, or says
        // "upload" / "host" → run the uploader and exit early.
        const wantsUpload =
            contentLower.includes('upload') ||
            contentLower.includes('host this') ||
            contentLower.includes('host it') ||
            message.attachments.size > 0 ||
            DISCORD_MSG_LINK_REGEX.test(message.content);

        if (wantsUpload) {
            console.log(`📤 Owner upload request from ${message.author.username}`);
            await handleOwnerUpload(message);
            return;
        }
        // ── END UPLOAD TRIGGER ────────────────────────────────────────────────

        // Build conversation context if they're replying to previous messages
        let conversationContext = "";
        
        // If in a thread, get thread context
        if (message.channel.isThread && message.channel.isThread()) {
            conversationContext += `\n[THREAD CONTEXT]\n`;
            conversationContext += `Thread Title: "${message.channel.name}"\n`;
            conversationContext += `This tells you what issue is being discussed.\n\n`;
        }
        
        if (message.reference) {
            try {
                // They're replying to a message - fetch conversation history
                const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
                const recentMessages = await message.channel.messages.fetch({ limit: 10 });
                
                conversationContext += "RECENT CONVERSATION:\n";
                recentMessages.reverse().forEach(msg => {
                    // Include ALL participants so Shubba is aware of multi-person conversations
                    let speaker;
                    if (msg.author.id === client.user.id) {
                        speaker = "Shubba";
                    } else {
                        speaker = msg.member?.nickname || msg.author.displayName || msg.author.username;
                        if (DEV_IDS.includes(msg.author.id)) speaker += " [dev]";
                    }
                    conversationContext += `${speaker}: ${msg.content.substring(0, 500)}\n`;
                });
            } catch (e) {
                console.log("⚠️ Couldn't fetch conversation history:", e.message);
            }
        }
        
        // Check for version set switch command - EXACT PHRASE REQUIRED
        if (isPrimaryOwner && (
            contentLower.includes('start documenting') || 
            contentLower.includes('now record') || 
            contentLower.includes('switch to')
        ) && contentLower.includes('solutions')) {
            const versionMatch = message.content.match(/(\d+\.\d+)/);
            if (versionMatch) {
                const newVersion = versionMatch[1];
                const response = await switchVersionSet(newVersion);
                return message.reply(response);
            }
        }
        
        // Check for administrative commands
        if (contentLower.includes('delete') && contentLower.includes('solutions') && contentLower.includes('version')) {
            const versionMatch = message.content.match(/version\s+(\d+\.\d+)/i);
            if (versionMatch) {
                const versionToDelete = versionMatch[1];
                if (SOLUTIONS_BY_VERSION[versionToDelete]) {
                    const count = SOLUTIONS_BY_VERSION[versionToDelete].length;
                    delete SOLUTIONS_BY_VERSION[versionToDelete];
                    await saveSolutionsToGCS();
                    return message.reply(`✅ Deleted ${count} solutions for version ${versionToDelete}.`);
                } else {
                    return message.reply(`⚠️ No solutions found for version ${versionToDelete}.`);
                }
            }
        }
        
        // Check for moderation commands
        if (contentLower.includes('ban') || contentLower.includes('kick') || contentLower.includes('mute') || contentLower.includes('timeout')) {
            return message.reply("I understand you want me to perform a moderation action. However, for safety reasons, I need you to use Discord's built-in moderation commands. I can help guide you on how to use them if needed!");
        }
        
        // For any other owner message, respond with Gemini - MORE CASUAL
        try {
            await message.channel.sendTyping();
            
            const freshKnowledge = await getFreshKnowledge();
            
            // Determine if this needs thinking
            const needsThinking = shouldUseThinking(message.content, false, false);
            
            const response = await callGemini(`You are Shubba, talking to one of your developers (${message.author.username}). This is a casual, direct conversation between colleagues.

DEVELOPER'S MESSAGE: ${message.content}
${conversationContext}

KNOWLEDGE BASE:
${freshKnowledge.substring(0, 30000)}

Instructions:
- Be casual, direct, and helpful - you're talking to a dev, not a user
- NO formal introductions like "I am Shubba" or "I know about Punchy"
- NO redundant statements like "anything else I can help with"
- Skip the pleasantries - just answer directly and efficiently
- Use natural, conversational language like you're chatting with a coworker
- Be friendly but concise
- If asked about technical details, provide them directly without fluff
- IMPORTANT: If there's conversation context above, remember what was said and continue naturally

Respond naturally as a helpful colleague.`, needsThinking.useThinking);
            
            const chunks = splitMessage(response);
            await message.reply(chunks[0]);
            for (let i = 1; i < chunks.length; i++) {
                await message.channel.send(chunks[i]);
            }
            
            return; // Exit early - owner was helped
        } catch (e) {
            console.error("Error responding to owner:", e);
            return message.reply("Sorry, I had trouble processing that. Could you try again?");
        }
    }

    if (isMentioned && contentLower.includes("analyze this")) {
        console.log(`🔍 Analysis requested by ${message.author.username}`);
        
        // DEVS: Can analyze their own attachments/links without replying
        if (isDev && !message.reference) {
            try {
                await message.channel.sendTyping();
                
                const { details, logContent } = await analyzeAttachments(message, message.channelId);
                if (!logContent) {
                    return message.reply("⚠️ No log files or URLs found in your message. Please attach a log file or paste a log URL (mclo.gs, pastebin, etc.)");
                }

                const statusMsg = await message.reply("🔍 **Deep Analysis Started.** Reading log files and cross-referencing with knowledge base...");
                await message.channel.sendTyping();

                const freshKnowledge = await getFreshKnowledge();
                const conversationContext = buildConversationContext(message.channelId);
                
                console.log(`📊 Performing deep analysis on ${logContent.length} characters of log data`);
                
                const report = await askGemini(
                    "PERFORM DEEP ANALYSIS. Provide a 'Full Gemini Report'.", 
                    message.channel, 
                    [], 
                    details, 
                    logContent, 
                    [], 
                    conversationContext, 
                    freshKnowledge,
                    true // Deep analysis mode
                );
                
                if (report.startsWith("ERROR:")) {
                    return statusMsg.edit(`❌ **Analysis Failed**: ${report.substring(6)}`);
                }

                addToThreadMemory(message.channelId, client.user.username, report, true);
                
                const { cleanText, attachments } = processAiVisuals(report);
                const chunks = splitMessage(cleanText);
                
                await statusMsg.edit({ content: `📊 **Deep Technical Analysis Report**\n\n${chunks[0]}`, files: attachments });
                
                for (let i = 1; i < chunks.length - 1; i++) {
                    await message.channel.send(chunks[i]);
                }
                
                if (chunks.length > 1) {
                    await message.channel.send({ content: chunks[chunks.length - 1], components: [getSupportButtons()] });
                } else {
                    await statusMsg.edit({ components: [getSupportButtons()] });
                }
                
                console.log(`✅ Analysis complete for ${message.author.username}`);
                return; // Exit after analysis
            } catch (e) { 
                console.error("❌ Analysis Error:", e); 
                return message.reply("❌ Error occurred during analysis. Please try again or contact support."); 
            }
        }
        
        // EVERYONE ELSE: Must reply to a message with attachments
        if (message.reference) {
            try {
                const targetMsg = await message.channel.messages.fetch(message.reference.messageId);
                await message.channel.sendTyping();
                
                const { details, logContent } = await analyzeAttachments(targetMsg, message.channelId);
                if (!logContent) {
                    return message.reply("⚠️ No log files or URLs found to analyze in that message. Make sure the message has an attached log file or a log URL.");
                }
                
                const statusMsg = await message.reply("🔍 **Deep Analysis Started.** Reading the entire log file and cross-referencing with knowledge base...");
                await message.channel.sendTyping();

                const freshKnowledge = await getFreshKnowledge();
                const conversationContext = buildConversationContext(message.channelId);
                
                console.log(`📊 Performing deep analysis on ${logContent.length} characters of log data`);
                
                const report = await askGemini(
                    "PERFORM DEEP ANALYSIS. Provide a 'Full Gemini Report'.", 
                    message.channel, 
                    [], 
                    details, 
                    logContent, 
                    [], 
                    conversationContext, 
                    freshKnowledge,
                    true // Deep analysis mode
                );
                
                if (report.startsWith("ERROR:")) {
                    return statusMsg.edit(`❌ **Analysis Failed**: ${report.substring(6)}`);
                }

                addToThreadMemory(message.channelId, client.user.username, report, true);
                
                const { cleanText, attachments } = processAiVisuals(report);
                const chunks = splitMessage(cleanText);
                
                await statusMsg.edit({ content: `📊 **Deep Technical Analysis Report**\n\n${chunks[0]}`, files: attachments });
                
                for (let i = 1; i < chunks.length - 1; i++) {
                    await message.channel.send(chunks[i]);
                }
                
                if (chunks.length > 1) {
                    await message.channel.send({ content: chunks[chunks.length - 1], components: [getSupportButtons()] });
                } else {
                    await statusMsg.edit({ components: [getSupportButtons()] });
                }
                
                console.log(`✅ Analysis complete`);
            } catch (e) { 
                console.error("❌ Analysis Error:", e); 
                return message.reply("❌ Error occurred during analysis. Please try again."); 
            }
        } else {
            return message.reply("💡 **How to use analysis:**\n• Reply to a message with a log file or log URL and say **@Shubba analyze this**\n• Or attach a log file to your message when you say **@Shubba analyze this**");
        }
        
        return; // Exit after handling analysis
    }

    if (contentLower.includes("shubba") && contentLower.includes("restart") && isAdmin) { 
        await message.reply("🔄 Got it! Rebooting..."); 
        process.exit(0); 
    }

    // Check for dot commands anywhere in the message
    if (contentLower.includes('.wiki')) {
        return message.reply(`📚 **Punchy Wiki:** ${WIKI_LINK}`);
    }
    
    if (contentLower.includes('.faq')) {
        return message.reply(`🙋 **FAQ Channel:** <#${FAQ_CHANNEL_ID}>`);
    }
    
    if (contentLower.includes('.compat')) {
        return message.reply(`🔗 **Compatible Mods Collection:** <https://modrinth.com/collection/GypBAs4y>\nCheck out mods that work well with Punchy!`);
    }
    
    // Check for commands at the start (for other commands like .solve, .translate)
    if (message.content.startsWith('.')) {
        const cmd = message.content.slice(1).trim().split(/ +/)[0].toLowerCase();
        if (cmd === 'solve' && isAdmin && message.channel.isThread()) return await solveThread(message.channel, message);
        if (cmd === 'translate' && message.reference) {
            const args = message.content.slice(1).trim().split(/ +/);
            const lang = args[1] || 'English';
            const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
            await message.channel.sendTyping();
            const prompt = `Translate to ${lang}: ${repliedTo.content}`;
            try {
                const translation = await callGemini(prompt, false); // Simple translation uses flash
                return message.reply(`🌍 **Translation (${lang}):**\n${translation}`);
            } catch (e) {
                return message.reply("❌ Translation failed.");
            }
        }
    }

    // Only process thread messages from support or wiki forums
    if (message.channel.parentId !== SUPPORT_FORUM_ID && message.channel.parentId !== WIKI_FORUM_ID) return;
    const thread = message.channel;
    const isWikiForum = thread.parentId === WIKI_FORUM_ID;
    
    // Check thread state FIRST before doing anything
    const isHumanRequested = thread.name.startsWith('(HUMAN HELP)');
    const isPaused = pausedThreads.has(thread.id);
    const isSolved = thread.name.startsWith('[SOLVED]');
    
    // CRITICAL: If thread is paused/human help/solved, ONLY respond if explicitly mentioned
    if (isHumanRequested || isPaused || isSolved) {
        if (!isMentioned) {
            console.log(`🔇 Ignoring message in ${thread.name} - Thread paused/human help/solved and bot not mentioned`);
            return; // Exit immediately - don't even add to memory
        }
        // If we get here, bot was mentioned, so we can respond
        console.log(`🔔 Bot was mentioned in paused/human help/solved thread ${thread.name} - will respond`);
    }
    
    // In follow-up messages, only respond when an owner explicitly @mentions Shubba
    if (isMentioned && !managedThreads.has(thread.id)) {
        managedThreads.add(thread.id);
        console.log(`📌 Added thread ${thread.name} to managed threads`);
    }

    // Only respond to owner @mentions in threads (ThreadCreate handles the initial auto-response)
    if (isMentioned && isOwner) {
        // Analyze conversation dynamics - who's talking to whom?
        const dynamics = await analyzeConversationDynamics(message);
        console.log(`💬 Conversation type: ${dynamics.conversationType} - ${dynamics.contextNote}`);
        
        // If someone is talking to others (not the bot), don't respond unless it's a dev collaboration
        if (dynamics.conversationType === 'TALKING_TO_OTHERS' && dynamics.conversationType !== 'DEV_COLLABORATION') {
            console.log(`⏭️ Skipping - user is talking to others, not the bot`);
            return;
        }
        
        addToThreadMemory(thread.id, message.author.username, message.content, false);
        extractUserInfo(thread.id, message.content);
        
        const { details, logContent, hasVideo } = await analyzeAttachments(message, thread.id);
        if (hasVideo && !isWikiForum) return await requestHumanHelp(thread, "Video attachment detected.");

        try {
            if (processingThreads.has(thread.id)) return;
            processingThreads.add(thread.id);
            await thread.sendTyping();
            
            if (!isWikiForum) {
                await applyTagsFromText(message, thread);
            }
            
            const freshKnowledge = await getFreshKnowledge();
            
            let conversationContext = buildConversationContext(thread.id);
            
            // Add conversation dynamics context
            conversationContext += `\n\n=== CONVERSATION DYNAMICS ===\n`;
            conversationContext += `${dynamics.contextNote}\n`;
            conversationContext += `Author: ${dynamics.author.nickname || dynamics.author.displayName} (@${dynamics.author.username})\n`;
            if (dynamics.author.isKewz) conversationContext += `  ^ This is kewz., the PRIMARY OWNER/LEAD DEVELOPER\n`;
            if (dynamics.author.isPunchyMan) conversationContext += `  ^ This is PunchyMan, the CO-OWNER/CO-DEVELOPER\n`;
            if (dynamics.author.isDev && !dynamics.author.isKewz && !dynamics.author.isPunchyMan) conversationContext += `  ^ This is a developer\n`;
            
            if (dynamics.mentionedUsers.length > 0) {
                conversationContext += `\nOther people mentioned in this message:\n`;
                dynamics.mentionedUsers.forEach(u => {
                    conversationContext += `- ${u.nickname || u.displayName} (@${u.username})`;
                    if (u.isPunchyMan) conversationContext += ` <- PunchyMan (CO-OWNER/CO-DEVELOPER!)`;
                    conversationContext += `\n`;
                });
            }
            
            if (dynamics.mentionsPunchyMan === 'mentioned_in_text') {
                conversationContext += `\nIMPORTANT: "Punchy Man" or "PunchyMan" was mentioned in the text - this refers to the CO-OWNER/CO-DEVELOPER!\n`;
            }
            
            if (dynamics.mentionsOP) {
                conversationContext += `\nNote: This message is a reply to someone else's message (possibly the OP)\n`;
            }
            
            // Wiki forum uses different prompt with language detection
            if (isWikiForum) {
                // Wait a moment to see if user is still typing/sending follow-up messages
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                // Check if they sent more messages in the last 3 seconds
                const recentMessages = await thread.messages.fetch({ limit: 5 });
                const userMessages = Array.from(recentMessages.values())
                    .filter(m => m.author.id === message.author.id && m.createdTimestamp > Date.now() - 5000)
                    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
                
                // If they sent multiple messages quickly, combine them
                let fullMessage = message.content;
                if (userMessages.length > 1) {
                    fullMessage = userMessages.map(m => m.content).join(' ');
                    console.log(`📝 Combined ${userMessages.length} messages from user into one response`);
                }
                
                // Detect language from current message
                const detectedLang = detectLanguage(fullMessage);
                const langInfo = SUPPORTED_LANGUAGES[detectedLang];
                console.log(`🌐 Continuing conversation in: ${langInfo.nativeName} (${detectedLang})`);
                
                // Fetch knowledge in detected language
                const freshKnowledge = await getFreshKnowledge(false, detectedLang);
                
                // Build wiki links - SUPPRESS EMBEDS
                const wikiLinks = WIKI_PAGES.map(page => {
                    const url = `https://github.com/punchy-mod/punchy-wiki/wiki/${page}-${detectedLang}`;
                    return `${page.replace(/-/g, ' ')}: <${url}>`; // Angle brackets suppress embeds
                }).join('\n');
                
                const wikiPrompt = `You are Shubba, a knowledgeable wiki expert for the Punchy! Minecraft mod. Continue this conversation naturally.

IMPORTANT: Respond in ${langInfo.name} (${langInfo.nativeName}).

THREAD CONTEXT: "${thread.name}"

CONVERSATION HISTORY (UNDERSTAND THE FLOW):
${conversationContext}

LATEST MESSAGE(S): ${fullMessage}

WIKI KNOWLEDGE (YOU'VE READ AND UNDERSTOOD THIS):
${freshKnowledge.substring(0, 40000)}

AVAILABLE WIKI PAGES (use <angle brackets> to prevent embeds):
${wikiLinks}

CRITICAL INSTRUCTIONS - BE A SMART WIKI EXPERT:
1. READ THE CONVERSATION: Understand what's been discussed and what the user needs
2. DON'T REPEAT YOURSELF: If you already explained something, don't explain it again
3. BE CONTEXT AWARE: If user is just adding to their question, acknowledge it naturally
4. EXPLAIN IN YOUR OWN WORDS: Don't copy-paste wiki content, explain it like teaching a friend
5. BE CONVERSATIONAL: Natural language, not documentation-speak
6. ONLY LINK WHEN HELPFUL: If wiki has more detail, suggest: "Check out <URL> for more"
7. ANSWER DIRECTLY FIRST: Try to answer without sending them to wiki unless needed
8. BE CONCISE: Get to the point, don't dump large sections of wiki
9. USE EXAMPLES: Practical examples help more than theory
10. SUPPRESS EMBEDS: Always use <angle brackets> around URLs

FORMATTING RULES (CRITICAL):
- JSON blocks: Use three backticks followed by 'json' with proper indentation, NO numbered lists inside
- Wiki links: "Page Name: <URL>" NOT "[Page Name](<URL>)"
- Ensure blank lines before/after code blocks
- Keep JSON clean and properly formatted

LANGUAGE: Respond entirely in ${langInfo.name}

Example GOOD responses:
- User asks "How to...": Give clear steps, mention wiki for details
- User says "please": Just acknowledge naturally, don't repeat everything
- User adds info: "Got it, so you need X. In that case..."

Example BAD responses (don't do this):
- Copying entire wiki sections word-for-word
- Repeating the same information already given
- Treating every message as a new question

Be helpful, smart, and natural. Remember the conversation!`;

                const rawAnswer = await callGemini(wikiPrompt, false); // Wiki uses flash mode
                
                // Quality check and fix response before sending
                const fixedAnswer = qualityCheckResponse(rawAnswer, detectedLang);
                validateWikiLinks(fixedAnswer); // Log any remaining issues
                
                addToThreadMemory(thread.id, client.user.username, fixedAnswer, true);
                
                const chunks = splitMessage(fixedAnswer);
                await thread.send(chunks[0]);
                for (let i = 1; i < chunks.length - 1; i++) {
                    await thread.send(chunks[i]);
                }
                
                // Add buttons on last message for wiki forum too
                if (chunks.length > 1) {
                    await thread.send({ content: chunks[chunks.length - 1], components: [getSupportButtons()] });
                } else {
                    const messages = await thread.messages.fetch({ limit: 1 });
                    const lastMsg = messages.first();
                    await lastMsg.edit({ components: [getSupportButtons()] });
                }
            } else {
                // Support forum - existing behavior
                const tags = thread.appliedTags.map(tagId => thread.parent.availableTags.find(t => t.id === tagId)?.name || "Tag");
                
                // AUTO DEEP ANALYSIS: If log content detected, perform deep analysis automatically
                const hasLogFile = logContent.length > 100;
                const isDeepAnalysis = hasLogFile;
                
                if (isDeepAnalysis) {
                    console.log(`🔍 Auto-triggering deep analysis for message in thread: ${thread.name}`);
                    await message.reply("🔍 **Log file detected! Performing deep technical analysis...**");
                }
                
                const rawAnswer = await askGemini(
                    message.content, 
                    thread, 
                    tags, 
                    details, 
                    logContent, 
                    checkTagCompliance(tags), 
                    conversationContext, 
                    freshKnowledge,
                    isDeepAnalysis // Pass deep analysis flag
                );
                
                if (rawAnswer.startsWith("ERROR:")) {
                    processingThreads.delete(thread.id);
                    return await requestHumanHelp(thread, "AI analysis failed - " + rawAnswer.substring(6));
                }
                
                addToThreadMemory(thread.id, client.user.username, rawAnswer, true);
                
                const { cleanText, attachments } = processAiVisuals(rawAnswer);
                const chunks = splitMessage(cleanText);
                
                // Add report header if deep analysis was performed
                const firstChunk = isDeepAnalysis 
                    ? `📊 **Deep Technical Analysis Report**\n\n${chunks[0]}`
                    : chunks[0];
                
                await thread.send({ content: firstChunk, files: attachments });
                
                for (let i = 1; i < chunks.length - 1; i++) {
                    await thread.send(chunks[i]);
                }
                
                if (chunks.length > 1) {
                    await thread.send({ content: chunks[chunks.length - 1], components: [getSupportButtons()] });
                } else {
                    const messages = await thread.messages.fetch({ limit: 1 });
                    const lastMsg = messages.first();
                    await lastMsg.edit({ components: [getSupportButtons()] });
                }
            }
            
        } catch (error) { 
            console.error("❌ Error responding:", error); 
        } finally { 
            processingThreads.delete(thread.id); 
        }
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
        const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.Administrator);
        if (!isAdmin) return await interaction.reply({ content: "❌ Admin only.", flags: [MessageFlags.Ephemeral] });
        
        if (interaction.commandName === 'restart') { 
            await interaction.reply("🔄 Rebooting..."); 
            process.exit(0); 
        }
        
        if (interaction.commandName === 'solve') {
            if (!interaction.channel.isThread()) {
                return await interaction.reply({ content: "This command only works in threads.", flags: [MessageFlags.Ephemeral] });
            }
            
            await interaction.deferReply({ ephemeral: false });
            
            try {
                await solveThread(interaction.channel, interaction);
            } catch (e) {
                console.error("Error in solve command:", e);
                try {
                    await interaction.editReply({ content: "⚠️ Something went wrong while solving. Check logs." });
                } catch (err) {
                    console.error("Failed to send error reply:", err);
                }
            }
        }
        
        if (interaction.commandName === 'pause_bot') { 
            pausedThreads.add(interaction.channelId); 
            await interaction.reply("⏸️ Paused."); 
        }
        
        if (interaction.commandName === 'resume_bot') { 
            pausedThreads.delete(interaction.channelId); 
            await interaction.reply("▶️ Resumed."); 
        }
        
        if (interaction.commandName === 'refresh_knowledge') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            await getFreshKnowledge(true);
            await interaction.editReply("✅ Knowledge base force-refreshed!");
        }
        
        if (interaction.commandName === 'test_wiki') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            let report = "📚 **Wiki Page Test Results:**\n\n";
            
            // Test just English and one other language for quick results
            const testLangs = ['EN-US', 'ZH-CN'];
            
            for (const lang of testLangs) {
                report += `**Testing ${SUPPORTED_LANGUAGES[lang].nativeName} (${lang}):**\n`;
                for (const page of WIKI_PAGES.slice(0, 2)) { // Test first 2 pages
                    const result = await fetchWikiPage(page, lang);
                    if (result) {
                        report += `✅ ${page} - ${result.content.length} chars\n`;
                    } else {
                        report += `❌ ${page} - Failed\n`;
                    }
                }
                report += '\n';
            }
            
            await interaction.editReply(report);
        }
        
        if (interaction.commandName === 'memory') {
            const memory = getThreadMemory(interaction.channelId);
            let memoryReport = "🧠 **Thread Memory Report**\n\n";
            memoryReport += `**Conversation Messages:** ${memory.conversationHistory.length}\n`;
            memoryReport += `**Has Log File:** ${memory.hasLog ? 'Yes' : 'No'}\n`;
            memoryReport += `**Has Modlist:** ${memory.hasModlist ? 'Yes' : 'No'}\n`;
            memoryReport += `**Game Version:** ${memory.userInfo.version || 'Unknown'}\n`;
            memoryReport += `**Mod Loader:** ${memory.userInfo.loader || 'Unknown'}\n`;
            memoryReport += `**Issues Tracked:** ${memory.userInfo.issues.join(', ') || 'None'}\n`;
            memoryReport += `**Attachments:** ${memory.attachments.length}\n`;
            memoryReport += `**Solutions Attempted:** ${memory.solveAttempts.length}\n`;
            await interaction.reply({ content: memoryReport, flags: [MessageFlags.Ephemeral] });
        }
        
        if (interaction.commandName === 'summary') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const conversationContext = buildConversationContext(interaction.channelId);
            const summary = await getSummary(conversationContext, interaction.channel.name);
            await interaction.editReply({ content: `📜 **Summary:**\n\n${summary}` });
        }
        
        if (interaction.commandName === 'versions') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            await fetchModrinthVersions(); // Refresh versions
            
            let report = "📦 **Latest Punchy Versions (Modrinth)**\n\n";
            
            if (Object.keys(LATEST_VERSIONS).length === 0) {
                report += "⚠️ No versions loaded. Try `/refresh_knowledge` first.";
            } else {
                // Group by MC version
                const grouped = {};
                Object.entries(LATEST_VERSIONS).forEach(([key, info]) => {
                    if (!grouped[info.mcVersion]) grouped[info.mcVersion] = [];
                    grouped[info.mcVersion].push(info);
                });
                
                Object.entries(grouped).forEach(([mcVersion, versions]) => {
                    report += `**Minecraft ${mcVersion}:**\n`;
                    versions.forEach(v => {
                        report += `  • ${v.loader.toUpperCase()}: \`${v.filename}\`\n`;
                    });
                    report += '\n';
                });
            }
            
            await interaction.editReply(report);
        }
        
        if (interaction.commandName === 'solutions') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            
            const currentSolutions = SOLUTIONS_BY_VERSION[CURRENT_VERSION_SET] || [];
            let report = `💾 **Solved Solutions Database**\n\n`;
            report += `**Current Version:** ${CURRENT_VERSION_SET}\n`;
            report += `**Solutions for ${CURRENT_VERSION_SET}:** ${currentSolutions.length}/${MAX_SOLUTIONS_PER_VERSION}\n\n`;
            
            // Show all versions available
            const allVersions = Object.keys(SOLUTIONS_BY_VERSION);
            if (allVersions.length > 1) {
                report += `**All Version Sets:**\n`;
                allVersions.forEach(v => {
                    const count = SOLUTIONS_BY_VERSION[v].length;
                    const current = v === CURRENT_VERSION_SET ? ' ✅ (current)' : '';
                    report += `  • v${v}: ${count} solutions${current}\n`;
                });
                report += '\n';
            }
            
            if (currentSolutions.length === 0) {
                report += `No solutions stored yet for version ${CURRENT_VERSION_SET}. Solutions are automatically saved when you use \`/solve\`.`;
            } else {
                report += `**Recent Solutions (${CURRENT_VERSION_SET}):**\n\n`;
                currentSolutions.slice(0, 10).forEach((solution, index) => {
                    report += `**${index + 1}. ${solution.threadName}**\n`;
                    report += `Tags: ${solution.tags.join(', ') || 'None'}\n`;
                    report += `Solved: ${new Date(solution.solvedDate).toLocaleDateString()}\n`;
                    report += `Issue: ${solution.issue.substring(0, 100)}...\n\n`;
                });
                
                if (currentSolutions.length > 10) {
                    report += `\n... and ${currentSolutions.length - 10} more solutions for version ${CURRENT_VERSION_SET}.`;
                }
            }
            
            await interaction.editReply(report);
        }
    } else if (interaction.isButton()) {
        const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.Administrator);
        const isOwner = DEV_IDS.includes(interaction.user.id);
        
        if (interaction.customId === 'request_human_help') {
            // Anyone can request human help
            await interaction.deferReply({ ephemeral: true });
            await requestHumanHelp(interaction.channel, "User requested help.");
            await interaction.editReply({ content: "✅ Flagged for human help." });
        } else if (interaction.customId === 'mark_as_solved') {
            // Anyone can mark as solved (thread creator, admins, or owners)
            const thread = interaction.channel;
            const isThreadCreator = thread.ownerId === interaction.user.id;
            
            if (!isAdmin && !isOwner && !isThreadCreator) {
                return interaction.reply({ 
                    content: "❌ Only the thread creator, admins, or moderators can mark this as solved.", 
                    flags: [MessageFlags.Ephemeral] 
                });
            }
            
            await interaction.deferReply({ ephemeral: false });
            
            try {
                await solveThread(interaction.channel, interaction);
            } catch (e) {
                console.error("Error in mark_as_solved:", e);
                try {
                    await interaction.editReply({ content: "⚠️ Something went wrong. Check logs." });
                } catch (err) {
                    console.error("Failed to send error reply:", err);
                }
            }
        }
    }
});

async function askGemini(latest, thread, tags, files, data, missing, conversationContext, freshKnowledge, isDeep = false, detectedVersion = null) {
  // Build version context
  let versionContext = "";
  if (detectedVersion) {
      const versionStatus = checkVersionStatus(detectedVersion);
      if (versionStatus) {
          versionContext = `\n[USER'S PUNCHY VERSION]\n`;
          versionContext += `Detected: ${detectedVersion}\n`;
          versionContext += `Latest: ${versionStatus.latestFilename || 'Unknown'}\n`;
          versionContext += `Status: ${versionStatus.isOutdated ? 'OUTDATED - User should update!' : 'Up to date'}\n`;
      }
  }
  
  // Build thread context
  let threadContext = "";
  if (thread && thread.name) {
      threadContext = `\n[THREAD CONTEXT]\n`;
      threadContext += `Thread Title: ${thread.name}\n`;
      threadContext += `Forum: ${thread.parentId === WIKI_FORUM_ID ? 'Wiki Questions' : 'Bug Reports/Support'}\n`;
      threadContext += `Applied Tags: ${tags.join(', ') || 'None'}\n`;
  }
  
  // Determine if we should use thinking mode
  const modelDecision = shouldUseThinking(latest, data.length > 100, isDeep);
  const useThinking = modelDecision.useThinking;
  
  const prompt = isDeep ? 
    `ACT AS A SENIOR MINECRAFT MOD DEVELOPER & DEBUGGER. TASK: PERFORM A COMPREHENSIVE TECHNICAL ANALYSIS.

[LOG FILE CONTENT] 
${data.substring(0, 45000)}
${versionContext}
${threadContext}

[CONVERSATION CONTEXT] 
${conversationContext}

[CURRENT KNOWLEDGE BASE - WIKI, DISCORD, TRELLO, MODRINTH VERSIONS]
${freshKnowledge.substring(0, 25000)}

[USER MESSAGE]
${latest}

[INSTRUCTIONS] 
Analyze this crash report or log file thoroughly. Create a structured technical report with these sections:

**[PROBLEM SUMMARY]**
- What error occurred (e.g., crash, rendering issue, mod conflict)
- When it happens (startup, gameplay, specific action)
- Impact on the user

**[VERSION CHECK]**
${detectedVersion ? `- User is running: ${detectedVersion}` : '- Could not detect Punchy version from log'}
- Check if this is the latest version and recommend updating if outdated

**[ROOT CAUSE]**
- Identify the exact cause from the log
- Quote specific error messages or stack traces
- Name conflicting mods if applicable
- Point to exact line numbers in the log
- Reference any similar solved issues from the solutions database

**[TECHNICAL DETAILS]**
- Java/Minecraft version
- Mod loader (Fabric/Forge/NeoForge) and version
- Punchy mod version
- Other relevant mods involved
- Error codes or exception types
- Stack trace analysis

**[FIX STEPS]**
Provide clear, numbered steps:
1. Step one with specific actions
2. Step two with file paths or commands
3. Alternative solutions if available

**[PREVENTION]**
How to avoid this in the future

Be technical but clear. Reference specific lines from the log when relevant. If you see similar issues in the solved solutions database, reference those solutions. If the user is on an outdated version, strongly recommend updating as the first step.` :
    `You are Shubba, a patient and friendly support bot for the Punchy! Minecraft mod. You are helpful, understanding, and remember the full context of conversations.

CRITICAL - USE REASONING AND NATURAL LANGUAGE UNDERSTANDING:
- READ and UNDERSTAND what the user is actually asking, not just match keywords
- Users phrase things differently - understand their INTENT, not just their exact words
- Examples:
  * "Can I use this with X?" = asking about compatibility
  * "How do I get Y working?" = asking for setup/configuration help
  * "Z isn't showing up" = reporting a bug or asking for troubleshooting
  * "Where's the config?" = asking for file locations
  * "Make it work with W" = asking how to configure compatibility
- Think about what they're TRYING TO DO, not just what they wrote
- If they're asking about something you can help with, help them - don't ask unnecessary clarifying questions

MULTI-PARTY CONVERSATION AWARENESS:
- MULTIPLE PEOPLE can be in the conversation at once
- When someone tags BOTH you AND another person, they want input from both
- Examples of multi-party dynamics:
  * "kewz. tags you + PunchyMan" = Dev collaboration, both should see it
  * "User tags you + OP" = Bringing original poster back into discussion
  * "User tags someone else (not you)" = They're talking to that person, not you
- PAY ATTENTION to who is being addressed:
  * If they tag you = they want your response
  * If they tag you + others = they want everyone's input
  * If they DON'T tag you = probably not talking to you
- UNDERSTAND WHY they're tagging people:
  * Tagging OP = getting more info from who reported the issue
  * Tagging devs = escalating or collaborating
  * Tagging other users = asking for their experience

CONTEXT AWARENESS:
${threadContext}

CRITICAL - WHO IS WHO:
- **kewz.** (ID: 422458713987612685) = Primary owner and lead developer of Punchy mod
- **PunchyMan** (ID: 1413670292970274836) = Co-owner and co-developer of Punchy mod
- These are THE TWO OWNERS/DEVELOPERS - they run the project together
- If someone mentions "Punchy Man" or "PunchyMan" - they are talking about the CO-DEVELOPER, not a random user
- NEVER dismiss or ignore PunchyMan - he is literally one of the owners
- When kewz. and PunchyMan are discussing something, this is an OWNER-LEVEL conversation

SPECIAL INSTRUCTIONS FOR DEVS (kewz., PunchyMan):
- When a dev says something is "fixed" or provides status updates in a thread, keep it SHORT and simple
- Just acknowledge with brief responses like: "Noted! 👍" or "Got it, will be in the next update!"
- DO NOT mention updating Trello, known-issues channel, or release notes - devs handle that themselves
- DO NOT ask "which issue" if the thread title makes it obvious
- DO NOT be pushy or tell devs what to do - they're the owners, they know what they're doing
- If a dev is venting or joking around, just roll with it naturally - don't get all serious and pushy
- Example good responses: "Noted!", "Awesome, thanks for the fix!", "Got it! 👍", "Haha fair enough"

PERSONALITY GUIDELINES:
- Be patient and empathetic. Users are often frustrated when things don't work.
- Remember what was said earlier in the conversation. Don't ask for information already provided.
- If you've already suggested something and it didn't work, acknowledge that and try a different approach.
- Never be dismissive or impatient. 
- Use natural, conversational language, not robotic lists unless specifically helpful.
- If multiple solutions have failed, acknowledge the user's frustration and suggest escalating to developers.
- Check if similar issues were solved before and reference those solutions.
- BE CONTEXT AWARE: If the thread title is "Crash with Fresh Animations" and a dev says "This is fixed", you know they mean the Fresh Animations crash!

CONVERSATION CONTEXT (REMEMBER THIS):
${conversationContext}

CURRENT KNOWLEDGE BASE (WIKI, DISCORD FAQ, TRELLO BOARD, MODRINTH VERSIONS, SOLVED SOLUTIONS):
${freshKnowledge.substring(0, 30000)}
${versionContext}

CURRENT MESSAGE: "${latest}"

FORUM TAGS: [${tags.join(", ")}]

ATTACHED FILES INFO: ${files}

FILE DATA: ${data.substring(0, 20000)}

${missing.length > 0 ? `MISSING INFO: User hasn't provided: ${missing.join(', ')}. Politely ask for this if it's essential to help them.` : ''}

IMPORTANT: If you don't see a Punchy version mentioned, ask the user for their exact Punchy .jar filename (e.g., punchy-2.1-neoforge-1.21.11.jar). This is critical for troubleshooting.

THINK ABOUT WHAT THE USER NEEDS:
Before responding, ask yourself:
1. What is the user ACTUALLY trying to do?
2. What information do they need to accomplish that?
3. Can I provide that directly, or do I need more details?
4. Have they already provided information I'm about to ask for?

Respond naturally based on the full conversation history, thread context, current knowledge, and your understanding of their intent. Use reasoning, not keyword matching.`;

  try {
      const response = await callGemini(prompt, useThinking);
      console.log(`✅ Generated response using ${modelDecision.reason}`);
      return response;
  } catch (error) { 
      console.error("Gemini Error:", error.message);
      
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
          return "ERROR:The log file is too large for me to analyze within the time limit. Please try uploading a smaller portion of the log.";
      }
      
      if (error.response?.status === 429) {
          return "ERROR:API rate limit hit (this shouldn't happen on paid tier). Retrying...";
      }
      
      if (error.response?.status === 400) {
          return "ERROR:The file content couldn't be processed. It may be corrupted or in an unsupported format.";
      }
      
      return "ERROR:I encountered an unexpected issue. Let me flag this for a human developer."; 
  }
}

async function getSummary(fullChat, title) {
    const prompt = `Summarize this support thread titled "${title}". Include: what the user's issue is, what solutions have been tried, and the current status.\n\nConversation:\n${fullChat}`;
    
    try {
        return await callGemini(prompt, false); // Summaries use flash mode
    } catch (e) { 
        return "Error summarizing."; 
    }
}

function checkTagCompliance(tags) {
    const missing = [];
    if (!tags.some(t => TAG_CATEGORIES.VERSIONS.includes(t))) missing.push("Game Version");
    if (!tags.some(t => TAG_CATEGORIES.LOADERS.includes(t))) missing.push("Mod Loader");
    return missing;
}

// NOTE: Make sure your GCS bucket allows public reads so hosted URLs work.
// Run once: gsutil iam ch allUsers:objectViewer gs://shubba-solutions-storage
// Or set via GCP Console → Storage → Bucket → Permissions → Add allUsers as Storage Object Viewer

// --- POST NEW FAQ ---
/**
 * Posts the Punchy! 2.4 FAQ as multiple embeds to the FAQ channel.
 * Triggered by owner saying "@shubba post the new 2.4 faq".
 */
async function postFAQ(triggerMessage) {
    const faqChannel = await client.channels.fetch(FAQ_CHANNEL_ID);
    if (!faqChannel) {
        return triggerMessage.reply('❌ Could not find the FAQ channel.');
    }

    const ACCENT = 0x5865F2; // Discord blurple
    const lastUpdated = 'March 22, 2026';
    const version = '2.4';
    const supported = '1.21.11, 1.21.5, 1.21.1, 1.20.1 (Fabric, Forge, NeoForge)';

    // 1 — Header
    const headerEmbed = new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('📋 Punchy! Frequently Asked Questions')
        .setDescription(
            `**Last Update:** ${lastUpdated}  |  **Version:** ${version}\n` +
            `**Supported Versions:** ${supported}`
        );

    // 2 — Older versions
    const olderVersionsEmbed = new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('🚀 Will older versions (below 1.21.11) still get updates?')
        .setDescription(
            '**Yes!** We currently use **1.21.11** as our development base, ' +
            'but we actively backport features to all older supported versions.'
        );

    // 3 — Configuration
    const configEmbed = new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('⚙️ How do I configure the mod settings?')
        .setDescription(
            'Press **F8**, Punchy! 2.4 no longer needs dependencies for config.\n\n' +
            'If you have a configuration UI mod installed you can also access settings via ' +
            '**Mods › Punchy! › Config**:\n' +
            '• **Fabric:** Install [Mod Menu](https://modrinth.com/mod/modmenu)\n' +
            '• **Forge / NeoForge:** Install [Configured](https://www.curseforge.com/minecraft/mc-mods/configured)'
        );

    // 4 — Resource pack compatibility
    const resourcePackEmbed = new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('🎨 My Resource Pack isn\'t working with the mod?')
        .setDescription(
            'We have added workarounds to ensure **most** resource packs work automatically, ' +
            'but some issues may persist.\n\n' +
            '**Dev fix:** Add explicit compatibility via our wiki → <https://github.com/punchy-mod/punchy-wiki>\n\n' +
            'Press **F9** to access the brand-new **Item Positioner**, Arm Positioner and Profile Management.\n\n' +
            '**Quick fix via Config:**\n' +
            '• **Single item:** Add the specific ID (e.g. `examplemod:item_name`)\n' +
            '• **Whole mod:** Add the mod ID (e.g. `examplemod`) to disable Punchy rendering for all its items\n' +
            '*This reverts those items to standard vanilla rendering.*\n\n' +
            `For questions about documentation or custom animations, ask in <#${WIKI_FORUM_ID}>.`
        );

    // 5 — Supported packs / addons
    const packsEmbed = new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('📦 Where can I find supported packs?')
        .setDescription(
            '• **[Official Compatibility Collection](https://modrinth.com/collection/GypBAs4y)** — ' +
            'A curated list of packs with explicit Punchy! support.\n' +
            `• Check <#${ADDONS_CHANNEL_ID}> to find or share community-made packs.`
        );

    // 6 — Gallery
    const galleryEmbed = new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('📷 Gallery')
        .setDescription(
            `Post your screenshots and videos in <#${GALLERY_CHANNEL_ID}>.\n` +
            '> 💡 Use <https://catbox.moe/> to upload large files.'
        );

    // 7 — Roadmap
    const roadmapEmbed = new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('🗺️ Development Roadmap')
        .setDescription(`Want to see what's coming next? Check <#${ROADMAP_CHANNEL_ID}>.`);

    // 8 — Support channels
    const supportEmbed = new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('❓ Support Channels')
        .setDescription(
            `🐛 **Found a bug?** Report it in <#${SUPPORT_FORUM_ID}>\n` +
            `💡 **Have an idea?** Post in <#${SUGGESTIONS_CHANNEL_ID}>\n` +
            `📚 **Wiki questions?** Ask in <#${WIKI_FORUM_ID}>`
        );

    const embeds = [
        headerEmbed,
        olderVersionsEmbed,
        configEmbed,
        resourcePackEmbed,
        packsEmbed,
        galleryEmbed,
        roadmapEmbed,
        supportEmbed
    ];

    // Discord allows max 10 embeds per message; split into batches of 3 to keep it readable
    for (let i = 0; i < embeds.length; i += 3) {
        await faqChannel.send({ embeds: embeds.slice(i, i + 3) });
    }

    await triggerMessage.reply(`✅ Posted the 2.4 FAQ to <#${FAQ_CHANNEL_ID}>!`);
    console.log(`📋 FAQ 2.4 posted to ${FAQ_CHANNEL_ID} by ${triggerMessage.author.username}`);
}

client.login(DISCORD_TOKEN);