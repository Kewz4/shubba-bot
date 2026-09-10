/**
 * log-analyzer.js — read a Minecraft log properly instead of guessing at one.
 *
 * WHY THIS EXISTS — three failures seen in real support transcripts.
 *
 * 1. TRUNCATION WAS PRESENTED AS THE END OF THE LOG.
 *    index.js does `fetchedLog.substring(0, 50000)` and wraps the result in
 *    "--- START OF LOG ---" ... "--- END OF LOG ---". Shubba then told a user
 *    their game had HUNG, citing that the log "ends" mid-line. It did not end.
 *    That was the bot's own 50KB cap, read back as evidence about someone's
 *    game. Fabricating a cause out of an artefact of our own plumbing is the
 *    worst thing a support bot can do, so in this module:
 *      - a shortened excerpt ALWAYS carries an explicit truncation banner,
 *      - the banner sits ABOVE the log text, where the model reads it first,
 *      - the banner names which end was kept and how much was dropped,
 *      - and a truncated excerpt is NEVER closed with the words "END OF LOG".
 *    The cut keeps the TAIL. Crashes, freezes and "the last thing that
 *    happened" live at the end of a log; a head-first cut throws away exactly
 *    the lines worth reading.
 *
 * 2. GZIPPED LOGS WERE UNREADABLE. Minecraft ships `latest.log` plain and
 *    rotates older ones to `.log.gz`; users attach those. They were decoded as
 *    UTF-8 and became mush. Handled here with Node's built-in zlib — no npm
 *    dependency, because the host runs `npm install --production` and a new dep
 *    is deploy risk for no benefit.
 *
 * 3. THE MOD LIST IN THE LOG WAS NEVER EXAMINED. In one thread the cause was
 *    sitting in the boot-time mod list; a human found it there and Shubba
 *    contradicted him. extractFacts() lifts those facts out so an answer can
 *    cite them — and when a mixin fails it names the mod that OWNS the mixin,
 *    which is how you say "this is not Punchy's bug" with evidence rather than
 *    with a hunch.
 *
 * Pure, and dependency-free apart from zlib. Nothing here throws: every export
 * is fed arbitrary user upload, so junk in means empty-or-partial out, never an
 * exception that takes the message handler down with it.
 */

'use strict';

const zlib = require('zlib');

const LIMITS = {
    // Most we will hold as a decoded string. People really do attach 50MB
    // logs; we keep the tail of one and say so rather than melting the heap.
    MAX_TEXT_BYTES: 8 * 1024 * 1024,
    // Ceiling on gunzip output. A .log.gz is arbitrary user upload and so is
    // also a plausible zip bomb — never inflate without a limit.
    MAX_GUNZIP_BYTES: 32 * 1024 * 1024,
    // If even that ceiling is blown, re-inflate only this much INPUT so the
    // user still gets something readable out of the file.
    GZIP_SALVAGE_INPUT_BYTES: 2 * 1024 * 1024,
    DEFAULT_MAX_CHARS: 20000,
    MIN_MAX_CHARS: 400,
    MAX_MODS: 500,
    MODS_SHOWN: 40,
};

// ── Buffers and decoding ────────────────────────────────────────────────────

function toBuffer(input) {
    try {
        if (Buffer.isBuffer(input)) return input;
        if (typeof input === 'string') return Buffer.from(input, 'utf8');
        if (input instanceof ArrayBuffer) return Buffer.from(input);
        if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    } catch (e) { /* unusable input — treated as nothing */ }
    return null;
}

function isGzip(buf) {
    return Buffer.isBuffer(buf) && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/**
 * Decode bytes to text. Windows tooling hands out UTF-16 often enough that
 * index.js already sniffs for it; do the same here so behaviour matches.
 * `toString` never throws — bad bytes become U+FFFD — which is what we want:
 * a binary attachment should read as garbage, not blow up the handler.
 */
function decodeText(buf) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) return '';
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        return buf.subarray(3).toString('utf8');
    }
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
        return buf.subarray(2).toString('utf16le');
    }
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
        const body = Buffer.from(buf.subarray(2));
        if (body.length % 2 === 0) {
            try { return body.swap16().toString('utf16le'); } catch (e) { /* fall through to utf8 */ }
        }
    }
    return buf.toString('utf8');
}

/** Slicing a UTF-8 buffer mid-character leaves a stray U+FFFD; step past it. */
function alignUtf8Start(buf) {
    let i = 0;
    while (i < buf.length && i < 4 && (buf[i] & 0xC0) === 0x80) i++;
    return i === 0 ? buf : buf.subarray(i);
}

/**
 * Inflate a gzip member. A user upload can be cut short mid-stream (a failed
 * upload, a partially synced file), and Z_SYNC_FLUSH still yields everything
 * that inflated before the break — but in that case the log's END is missing,
 * which is the dangerous direction, so it is reported as kept:'head'.
 */
function gunzip(buf, meta) {
    if (!isGzip(buf)) return null;

    try {
        const out = zlib.gunzipSync(buf, { maxOutputLength: LIMITS.MAX_GUNZIP_BYTES });
        meta.gzip = true;
        return out;
    } catch (e) { /* incomplete, multi-member, or over the ceiling */ }

    try {
        const out = zlib.gunzipSync(buf, {
            finishFlush: zlib.constants.Z_SYNC_FLUSH,
            maxOutputLength: LIMITS.MAX_GUNZIP_BYTES,
        });
        meta.gzip = true;
        meta.kept = 'head';
        meta.warnings.push('the .gz stream is incomplete — decompressed as far as it goes, so the END of the log is missing');
        return out;
    } catch (e) { /* still over the ceiling, or not really gzip past the magic */ }

    try {
        const out = zlib.gunzipSync(buf.subarray(0, LIMITS.GZIP_SALVAGE_INPUT_BYTES), {
            finishFlush: zlib.constants.Z_SYNC_FLUSH,
            maxOutputLength: LIMITS.MAX_GUNZIP_BYTES,
        });
        meta.gzip = true;
        meta.kept = 'head';
        meta.warnings.push('the .gz inflates past our size ceiling — only the beginning was decompressed');
        return out;
    } catch (e) { /* give up on gzip; the caller decodes the raw bytes instead */ }

    return null;
}

/**
 * Full-detail decompress. `decompressIfNeeded` is the string-only wrapper; use
 * this one when you need to know what was dropped, because that is what the
 * truncation banner is built from.
 *
 * @returns {{text:string, gzip:boolean, kept:'all'|'head'|'tail',
 *            inputBytes:number, decodedBytes:number, keptBytes:number,
 *            warnings:string[]}}
 */
function decompress(input, filename) {
    const meta = {
        text: '', gzip: false, kept: 'all',
        inputBytes: 0, decodedBytes: 0, keptBytes: 0, warnings: [],
    };

    let buf = toBuffer(input);
    if (!buf || buf.length === 0) return meta;
    meta.inputBytes = buf.length;

    const name = String(filename == null ? '' : filename).toLowerCase();
    // Trust the magic bytes over the name: a mislabelled ".gz" that is really
    // plain text must still be readable, and a ".log" that is really gzip
    // (some launchers do this) must still be inflated.
    if (isGzip(buf) || /\.t?gz([?#]|$)/.test(name)) {
        const out = gunzip(buf, meta);
        if (out) buf = out;
    }
    meta.decodedBytes = buf.length;

    if (buf.length > LIMITS.MAX_TEXT_BYTES) {
        if (meta.kept === 'head') {
            // We already hold only the front of the file; keep it a front
            // rather than turning it into an unlabelled middle.
            buf = buf.subarray(0, LIMITS.MAX_TEXT_BYTES);
        } else {
            // Keep the TAIL: the end of a log is where the answer is.
            buf = alignUtf8Start(buf.subarray(buf.length - LIMITS.MAX_TEXT_BYTES));
            meta.kept = 'tail';
        }
        meta.warnings.push(`log is ${meta.decodedBytes} bytes — only ${buf.length} were read`);
    }

    meta.keptBytes = buf.length;
    meta.text = decodeText(buf);
    return meta;
}

/**
 * Gunzip when the bytes (or the name) say gzip; otherwise decode as text.
 * Never throws — returns '' when there is nothing readable at all.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer|string} buffer
 * @param {string} [filename]
 * @returns {string}
 */
function decompressIfNeeded(buffer, filename) {
    try {
        return decompress(buffer, filename).text;
    } catch (e) {
        return '';
    }
}

// ── Is this even a log? ─────────────────────────────────────────────────────

const NON_LOG_EXT = /\.(json|json5|cfg|conf|config|properties|ya?ml|toml|xml|md|csv|png|jpe?g|webp|gif|bmp|mp4|mov|webm|mp3|ogg|wav|zip|jar|mcmeta|nbt|dat|pdf|exe|dll|so|class)$/;

/**
 * Would it be worth handing this attachment to the log reader?
 * Accepts the rotated and gzipped forms Minecraft actually produces, and
 * tolerates being handed a full URL (Discord CDN links carry a query string).
 *
 * @param {string} filename
 * @param {string} [contentType]
 * @returns {boolean}
 */
function isLikelyLog(filename, contentType) {
    try {
        let name = String(filename == null ? '' : filename).trim();
        name = name.split(/[?#]/)[0];
        name = name.split(/[\\/]/).pop().toLowerCase();
        const ct = String(contentType == null ? '' : contentType).toLowerCase().split(';')[0].trim();

        // ".log.gz" -> ".log", so every rule below covers its gzipped twin.
        const base = name.replace(/\.gz$/, '');

        if (/\.(log|txt)$/.test(base)) return true;                 // latest.log, crash-*.txt, debug.log
        if (/\.log\.\d+$/.test(base)) return true;                  // latest.log.1 (rotated in place)
        if (/^hs_err_pid\d+/.test(base)) return true;               // JVM hard-crash dump
        if (/^(latest|debug|console|server|client)$/.test(base)) return true;
        // A bare ".gz" whose stem still reads like a log, e.g. "latest.gz".
        if (name.endsWith('.gz') && /(log|crash|debug|latest)/.test(base)) return true;

        // The name has settled the question if it carries a known non-log
        // extension — a content type must not drag a pack.mcmeta in here.
        if (NON_LOG_EXT.test(base)) return false;

        if (ct === 'text/plain' || ct === 'text/x-log' || ct === 'application/x-log') return true;
        if ((ct === 'application/gzip' || ct === 'application/x-gzip')
            && /(log|crash|debug|latest)/.test(name)) return true;

        return false;
    } catch (e) {
        return false;
    }
}

// ── Fact extraction ─────────────────────────────────────────────────────────

function emptyFacts() {
    return {
        minecraftVersion: null,
        loader: null,
        loaderVersion: null,
        javaVersion: null,
        punchyVersion: null,
        mods: [],
        crashed: false,
        exceptionType: null,
        failingMixin: null,
        failingMod: null,
        shaderpack: null,
        resourcePacks: [],
    };
}

function firstMatch(text, re, group) {
    const m = text.match(re);
    if (!m) return null;
    const v = m[group == null ? 1 : group];
    return v ? (v.trim() || null) : null;
}

/**
 * Parse the mod list both loaders print at boot, plus the two forms crash
 * reports use. This is defect #3: the answer is often already sitting here.
 */
function parseMods(text) {
    const mods = [];
    const seen = new Set();
    const add = (id, version) => {
        if (!id || mods.length >= LIMITS.MAX_MODS) return;
        const key = id.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        mods.push({ id, version: version || null });
    };

    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Fabric / Quilt latest.log:
        //   [main/INFO]: Loading 61 mods:
        //   \t- fabric-api 0.92.2+1.20.1
        //   \t   |-- fabric-api-base 0.4.31+1.20.1     (nested children)
        if (/Loading \d+ mods:/.test(line)) {
            for (let j = i + 1; j < lines.length; j++) {
                const m = lines[j].match(/^\s*(?:-|\|--|\\--|\|\s*\\--)\s*([A-Za-z0-9_][\w\-.]*)\s+(\S+)\s*$/);
                if (m) { add(m[1], m[2]); continue; }
                if (/^\s*$/.test(lines[j])) continue;
                i = j - 1;
                break;
            }
            continue;
        }

        // Forge / NeoForge crash-report "Mod List:" table — pipe delimited:
        //   punchy-2.7d.jar |Punchy! |punchy |2.7d |COMMON_SET|Manifest: ...
        if (line.indexOf('|') !== -1 && /\.jar\s*\|/.test(line)) {
            const cells = line.split('|').map(c => c.trim());
            if (cells.length >= 4 && /^[A-Za-z0-9_][\w\-.]*$/.test(cells[2]) && cells[3]) {
                add(cells[2], cells[3]);
                continue;
            }
        }

        // Fabric crash-report "Fabric Mods:" block — "\t\tpunchy: Punchy! 2.7d"
        const fab = line.match(/^\s{2,}([a-z0-9_][\w\-.]*):\s+\S.*?\s(\S+)\s*$/);
        if (fab && line.indexOf('[') === -1 && !/:\s*$/.test(line)) {
            add(fab[1], fab[2]);
        }
    }

    return mods;
}

function detectLoader(text, mods) {
    // NeoForge before Forge: every NeoForge string contains "forge".
    let v = firstMatch(text, /--fml\.neoForgeVersion,?\s*([\w.\-+]+)/)
        || firstMatch(text, /NeoForge(?:\s+mod loading,)?\s+version[:\s]+([\w.\-+]+)/i)
        || firstMatch(text, /-neoforge-([\w.\-+]+)/);
    if (v || /\bneoforge\b/i.test(text)) return { loader: 'neoforge', loaderVersion: v };

    v = firstMatch(text, /Quilt Loader ([\w.\-+]+)/);
    if (v || /\bquilt_loader\b/.test(text)) return { loader: 'quilt', loaderVersion: v };

    v = firstMatch(text, /Fabric Loader ([\w.\-+]+)/);
    if (!v) {
        const fl = mods.find(m => m.id.toLowerCase() === 'fabricloader');
        if (fl) v = fl.version;
    }
    if (v || /\bnet\.fabricmc\.loader\b/.test(text)) return { loader: 'fabric', loaderVersion: v };

    v = firstMatch(text, /Forge mod loading, version ([\w.\-+]+)/)
        || firstMatch(text, /-forge-([\w.\-+]+)/)
        || firstMatch(text, /--fml\.forgeVersion,?\s*([\w.\-+]+)/)
        || firstMatch(text, /\bForge Version:\s*([\w.\-+]+)/);
    if (v || /cpw\.mods\.modlauncher|net\.minecraftforge\.fml/.test(text)) {
        return { loader: 'forge', loaderVersion: v };
    }

    return { loader: null, loaderVersion: null };
}

function detectMinecraftVersion(text, mods) {
    const mc = firstMatch(text, /Minecraft Version:\s*([\w.\-]+)/)
        || firstMatch(text, /Loading Minecraft ([\w.\-]+) with/)
        || firstMatch(text, /--version,?\s*([0-9][\w.]*)-(?:neo)?forge-/)
        || firstMatch(text, /--fml\.mcVersion,?\s*([\w.\-]+)/)
        || firstMatch(text, /\bfor MC ([\w.\-]+)/);
    if (mc) return mc;
    const m = mods.find(x => x.id.toLowerCase() === 'minecraft');
    return m && m.version ? m.version : null;
}

function detectJavaVersion(text, mods) {
    const j = firstMatch(text, /Java Version:\s*([\w.+\-]+)/)
        || firstMatch(text, /Java is [^\r\n]*?version ([\w.+\-]+)/)
        || firstMatch(text, /\bjava\.version[:=]\s*([\w.+\-]+)/);
    if (j) return j;
    const m = mods.find(x => x.id.toLowerCase() === 'java');
    return m && m.version ? m.version : null;
}

function detectPunchyVersion(text, mods) {
    const m = mods.find(x => x.id.toLowerCase() === 'punchy');
    if (m && m.version) return m.version;
    return firstMatch(text, /punchy[-_ ]v?([0-9][\w.\-+]*)\.jar/i)
        || firstMatch(text, /\bPunchy!?\s+v?([0-9][\w.]*)/i);
}

const CRASH_MARKERS = [
    '---- Minecraft Crash Report ----',
    '# A fatal error has been detected by the Java Runtime Environment',
    'Exception in thread "',
    // Fabric's wording when a thread dies without a crash report being written.
    // The game is just as dead; only the banner is missing.
    'Uncaught exception in thread',
    'The game crashed whilst',
    'Minecraft has crashed!',
    'Failed to start the minecraft server',
    'net.fabricmc.loader.impl.FormattedException',
];

/** Where the interesting failure starts, or -1. Also drives excerpt choice. */
function findExceptionIndex(text) {
    if (typeof text !== 'string' || !text) return -1;

    let best = -1;
    for (const marker of CRASH_MARKERS) {
        const i = text.indexOf(marker);
        if (i !== -1 && (best === -1 || i < best)) best = i;
    }
    if (best !== -1) return best;

    // No banner — but a bare thrown exception followed by a stack frame is
    // still the place a human would scroll to.
    const m = text.match(/\n((?:[a-z][\w$]*\.){2,}[A-Z][\w$]*(?:Exception|Error|Throwable))[\s:][\s\S]{0,400}?\n\s+at\s/);
    return m && typeof m.index === 'number' ? m.index + 1 : -1;
}

function detectCrash(text) {
    for (const marker of CRASH_MARKERS) {
        if (text.indexOf(marker) !== -1) return true;
    }
    if (/\[[^\]\r\n]*\/FATAL\]/.test(text)) return true;
    if (/Process crashed with exit code/.test(text)) return true;
    return false;
}

function detectExceptionType(text, from) {
    const region = from >= 0 ? text.slice(from) : text;

    // The LAST "Caused by:" is the root cause, and the root cause is the
    // actionable one — that is the class worth naming in an answer.
    const causes = region.match(/Caused by:\s*((?:[\w$]+\.)+[A-Z][\w$]*)/g);
    if (causes && causes.length) {
        const last = causes[causes.length - 1].replace(/^Caused by:\s*/, '').trim();
        if (last) return last;
    }

    return firstMatch(region, /Exception in thread\s+"[^"]*"\s+((?:[\w$]+\.)+[A-Z][\w$]*)/)
        || firstMatch(region, /^[^\S\r\n]*((?:[a-z][\w$]*\.){2,}[A-Z][\w$]*(?:Exception|Error|Throwable))\s*(?::|$)/m)
        || firstMatch(region, /((?:[a-z][\w$]*\.){2,}[A-Z][\w$]*(?:Exception|Error))\b/);
}

// Package segments that identify nobody: shared prefixes, generic layer names,
// and the loaders themselves. Blaming "com" or "client" helps no one.
const MIXIN_NOISE = new Set([
    'net', 'com', 'org', 'io', 'me', 'dev', 'xyz', 'mod', 'mods', 'common',
    'client', 'server', 'core', 'impl', 'api', 'github', 'gitlab', 'minecraft',
    'fabricmc', 'minecraftforge', 'neoforged', 'spongepowered', 'asm', 'json',
    'mixin', 'mixins',
]);

/**
 * Work out which mod a failing mixin belongs to.
 *
 * This is the whole point of the exercise. When a third-party mixin blows up
 * inside a Minecraft class, the stack trace looks like a Minecraft (or Punchy)
 * problem and reads like one to anybody skimming. Naming the owning mod turns
 * "probably not us" into "here is the mod that failed, with its own mixin
 * config named in your log".
 *
 * Evidence in descending order of strength:
 *   1. the loader said so outright ("for mod X" / "from mod X"),
 *   2. the mixin config is named after its mod (sodium.mixins.json),
 *   3. a package segment of the mixin class matches an id in the mod list,
 *   4. the package segment sitting just before ".mixin"/".mixins".
 */
function detectMixinFailure(text, mods) {
    const result = { failingMixin: null, failingMod: null };

    const explicit = text.match(/Mixin apply for mod ([\w\-.]+) failed (\S+)/);
    if (explicit) { result.failingMod = explicit[1]; result.failingMixin = explicit[2]; }

    if (!result.failingMixin) {
        result.failingMixin = firstMatch(text, /Mixin (?:apply|prepare|transformation) failed (\S+)/)
            || firstMatch(text, /\b([\w\-.]+\.mixins?\.json:[\w$.]+)/)
            || firstMatch(text, /Mixin transformation of ([\w.$]+) failed/);
    }

    if (!result.failingMixin) {
        // Fall back to the first mixin class in the stack, e.g.
        //   at com.example.mod.mixin.HeldItemRendererMixin.handler$abc(...)
        const frame = text.match(/\bat\s+((?:[\w$]+\.)+mixins?\.(?:[\w$]+\.)*[A-Z][\w$]*)\./)
            || text.match(/\b((?:[\w$]+\.)+mixins?\.(?:[\w$]+\.)*[A-Z][\w$]*)\b/);
        if (frame) result.failingMixin = frame[1];
    }

    if (!result.failingMixin) return result;

    // 1. The loader named the owner itself.
    if (!result.failingMod) {
        result.failingMod = firstMatch(text, /\bfrom mod ([\w\-.]+)/)
            || firstMatch(text, /\bfor mod ([\w\-.]+)/)
            || firstMatch(text, /\bowned by mod ([\w\-.]+)/);
    }

    // 2. "<modid>.mixins.json" — the near-universal naming convention.
    if (!result.failingMod) {
        const cfg = result.failingMixin.match(/([\w\-.]+)\.mixins?\.json/);
        if (cfg) {
            const stem = cfg[1].split('.').pop();
            if (stem && !MIXIN_NOISE.has(stem.toLowerCase())) result.failingMod = stem;
        }
    }

    const segments = result.failingMixin.split(/[.:$/]/).filter(Boolean).map(s => s.toLowerCase());

    // 3. Cross-reference the package against mods actually loaded. This is the
    //    strongest evidence we can produce ourselves, because it proves the
    //    mod is present in THIS user's setup rather than merely plausible.
    if (!result.failingMod && mods && mods.length) {
        const byId = new Map(mods.map(x => [x.id.toLowerCase(), x.id]));
        for (const seg of segments) {
            if (MIXIN_NOISE.has(seg)) continue;
            if (byId.has(seg)) { result.failingMod = byId.get(seg); break; }
        }
    }

    // 4. Whatever package sits immediately before ".mixin"/".mixins".
    if (!result.failingMod) {
        const idx = segments.findIndex(s => s === 'mixin' || s === 'mixins');
        for (let i = idx - 1; i >= 0; i--) {
            if (!MIXIN_NOISE.has(segments[i])) { result.failingMod = segments[i]; break; }
        }
    }

    return result;
}

function detectShaderpack(text) {
    const v = firstMatch(text, /\[Iris\][^\r\n]*?(?:[Uu]sing|[Ll]oaded)\s+shaderpack:?\s*([^\r\n,]+)/)
        || firstMatch(text, /Loaded shaderpack:?\s*([^\r\n,]+)/)
        || firstMatch(text, /\bshaderPack[:=]\s*([^\r\n,]+)/);
    if (!v) return null;
    const clean = v.trim().replace(/[.,;]$/, '');
    if (!clean || /^(off|none|\(internal\)|internal)$/i.test(clean)) return null;
    return clean;
}

function detectResourcePacks(text) {
    const out = [];
    const seen = new Set();
    const push = (raw) => {
        const v = String(raw == null ? '' : raw).trim().replace(/[,;]$/, '');
        if (!v || v.length > 200) return;
        const key = v.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(v);
    };

    // Take the LAST reload: that is the pack set in force when things broke.
    const reloads = text.match(/Reloading ResourceManager:\s*([^\r\n]+)/g);
    if (reloads && reloads.length) {
        reloads[reloads.length - 1]
            .replace(/^Reloading ResourceManager:\s*/, '')
            .split(',')
            .forEach(push);
    }

    // The crash-report field.
    const field = text.match(/Resource Packs?:\s*([^\r\n]+)/);
    if (field) field[1].split(',').forEach(push);

    // Packs the game complained about are worth surfacing even when the reload
    // line never made it into the part of the log we are holding.
    const files = text.match(/\bfile\/[^\s,\]]+\.zip/g);
    if (files) files.forEach(push);

    return out;
}

/**
 * Pull out the things a support answer actually needs. Scalars are null when
 * the log does not say; `mods` and `resourcePacks` are always arrays.
 *
 * @param {string} text
 * @returns {{minecraftVersion:string|null, loader:string|null, loaderVersion:string|null,
 *            javaVersion:string|null, punchyVersion:string|null,
 *            mods:Array<{id:string,version:string|null}>, crashed:boolean,
 *            exceptionType:string|null, failingMixin:string|null, failingMod:string|null,
 *            shaderpack:string|null, resourcePacks:string[]}}
 */
function extractFacts(text) {
    const facts = emptyFacts();
    if (typeof text !== 'string' || text.length === 0) return facts;

    try {
        facts.mods = parseMods(text);

        const loader = detectLoader(text, facts.mods);
        facts.loader = loader.loader;
        facts.loaderVersion = loader.loaderVersion;

        facts.minecraftVersion = detectMinecraftVersion(text, facts.mods);
        facts.javaVersion = detectJavaVersion(text, facts.mods);
        facts.punchyVersion = detectPunchyVersion(text, facts.mods);

        facts.crashed = detectCrash(text);
        facts.exceptionType = detectExceptionType(text, findExceptionIndex(text));

        const mixin = detectMixinFailure(text, facts.mods);
        facts.failingMixin = mixin.failingMixin;
        facts.failingMod = mixin.failingMod;

        facts.shaderpack = detectShaderpack(text);
        facts.resourcePacks = detectResourcePacks(text);
    } catch (e) {
        // A malformed log must never cost us the facts we already collected.
    }

    return facts;
}

// ── Summarising for the model ───────────────────────────────────────────────

function clip(s, n) {
    if (typeof s !== 'string') return '';
    return s.length <= n ? s : s.slice(0, Math.max(0, n));
}

function renderMods(mods, blamed) {
    if (!mods.length) return null;
    const priority = [];
    const rest = [];
    for (const m of mods) {
        const id = m.id.toLowerCase();
        if (id === 'punchy' || (blamed && id === String(blamed).toLowerCase())) priority.push(m);
        else rest.push(m);
    }
    const shown = priority.concat(rest).slice(0, LIMITS.MODS_SHOWN);
    const listed = shown.map(m => (m.version ? `${m.id} ${m.version}` : m.id)).join(', ');
    const more = mods.length - shown.length;
    return `Mods (${mods.length} in the log): ${listed}${more > 0 ? ` (+${more} more)` : ''}`;
}

function renderFacts(facts, source) {
    const lines = [];
    lines.push('--- FACTS PARSED FROM THE LOG ---');
    // Said out loud because the facts come from the WHOLE file while the
    // excerpt below may be only its tail: the model must not "correct" a fact
    // just because it cannot see the line that fact came from.
    lines.push('(read from the entire log, including any part not shown below — trust these over the excerpt)');
    if (source) lines.push(`Source: ${source}`);
    if (facts.minecraftVersion) lines.push(`Minecraft: ${facts.minecraftVersion}`);
    if (facts.loader) lines.push(`Loader: ${facts.loader}${facts.loaderVersion ? ' ' + facts.loaderVersion : ''}`);
    if (facts.javaVersion) lines.push(`Java: ${facts.javaVersion}`);
    if (facts.punchyVersion) lines.push(`Punchy: ${facts.punchyVersion}`);
    const mods = renderMods(facts.mods, facts.failingMod);
    if (mods) lines.push(mods);
    if (facts.resourcePacks.length) lines.push(`Resource packs: ${facts.resourcePacks.slice(0, 20).join(', ')}`);
    if (facts.shaderpack) lines.push(`Shaderpack: ${facts.shaderpack}`);
    lines.push(`Crashed: ${facts.crashed ? 'YES' : 'no crash report or fatal error found'}`);
    if (facts.exceptionType) lines.push(`Exception: ${facts.exceptionType}`);
    if (facts.failingMixin) lines.push(`Failing mixin: ${facts.failingMixin}`);
    if (facts.failingMod) {
        lines.push(`Mixin owner: ${facts.failingMod} — that mixin belongs to "${facts.failingMod}", so the failure is in that mod's code.`);
    }
    return lines.join('\n');
}

/**
 * Build the compact block handed to the model.
 *
 * The truncation banner is the load-bearing part of this function. Shubba once
 * diagnosed a hang from a log that "ended" mid-line, when what had actually
 * happened was a 50000-character substring() upstream. So: if anything was cut,
 * this block says so in plain words, above the text, naming which end survived
 * — and it never signs off with "END OF LOG", because that exact phrasing is
 * what invited the wrong conclusion in the first place.
 *
 * @param {string} text
 * @param {{maxChars?:number, originalChars?:number, keptPart?:'tail'|'head'|'all', source?:string}} [opts]
 * @returns {string}
 */
function summarizeForPrompt(text, opts) {
    try {
        const o = opts && typeof opts === 'object' ? opts : {};
        let maxChars = Number(o.maxChars);
        if (!Number.isFinite(maxChars) || maxChars <= 0) maxChars = LIMITS.DEFAULT_MAX_CHARS;
        maxChars = Math.max(LIMITS.MIN_MAX_CHARS, Math.floor(maxChars));

        const str = typeof text === 'string' ? text : '';
        const source = o.source ? String(o.source).slice(0, 200) : null;

        if (str.trim().length === 0) {
            return '--- LOG FILE ---\nThe attached file contained no readable text (it may be empty, binary, or a corrupt archive). Do not guess at its contents; ask the user to re-upload it.';
        }

        // An upstream step may already have cut the file (our own byte cap, or
        // index.js's substring). Its number wins, because only it knows the
        // real original size.
        const reportedOriginal = Number(o.originalChars);
        const originalChars = Number.isFinite(reportedOriginal) && reportedOriginal > str.length
            ? Math.floor(reportedOriginal)
            : str.length;
        const cutUpstream = originalChars > str.length;
        const keepHead = o.keptPart === 'head';

        const facts = extractFacts(str);
        // Cap the facts so a 400-mod list can never crowd out the banner.
        const factsBlock = clip(renderFacts(facts, source), Math.floor(maxChars * 0.55));

        // Reserve room for the banner and footer before choosing an excerpt.
        const OVERHEAD = 900;
        let room = maxChars - factsBlock.length - OVERHEAD;
        if (room < 200) room = 200;

        // If the failure happened before the window we are about to keep, carry
        // it separately — an excerpt without the exception is useless.
        const exIdx = findExceptionIndex(str);
        let exceptionBlock = '';
        if (!keepHead && exIdx >= 0 && exIdx < str.length - room) {
            const exRoom = Math.min(Math.floor(room * 0.45), 6000);
            exceptionBlock = str.slice(exIdx, exIdx + exRoom);
            room = Math.max(200, room - exceptionBlock.length - 120);
        }

        let excerpt;
        if (keepHead) {
            excerpt = str.slice(0, room);
        } else {
            const start = Math.max(0, str.length - room);
            excerpt = str.slice(start);
            // A partial first line is precisely the thing that got misread as
            // "the log stops here"; drop the fragment rather than show it.
            if (start > 0) {
                const nl = excerpt.indexOf('\n');
                if (nl !== -1 && nl < excerpt.length - 1) excerpt = excerpt.slice(nl + 1);
            }
        }

        const truncated = cutUpstream || excerpt.length < str.length;
        const shownChars = excerpt.length;

        const out = [];
        out.push('=== MINECRAFT LOG (read and parsed by Shubba) ===');
        out.push(factsBlock);

        if (truncated) {
            if (keepHead) {
                out.push(
                    `\n[log truncated: showing the first ${shownChars} of ${originalChars} characters — the END is NOT included, `
                    + 'do not infer anything from where this stops. The text below stops because it was CUT to fit, not because '
                    + 'the game stopped. Never diagnose a hang, freeze or shutdown from the fact that this excerpt ends.]'
                );
            } else {
                out.push(
                    `\n[log truncated: showing the last ${shownChars} of ${originalChars} characters — the beginning is NOT included, `
                    + 'do not infer anything from where this starts. The excerpt begins where it does because it was CUT to fit; '
                    + 'a line appearing first, or appearing mid-sentence, means nothing about the game. What follows is the END '
                    + 'of the log, which is the part that matters.]'
                );
            }
        }

        if (exceptionBlock) {
            out.push('\n--- EXCEPTION / STACK TRACE (lifted from earlier in the log, out of order) ---');
            out.push(exceptionBlock);
            out.push('--- (end of the lifted exception; the log continues below) ---');
        }

        out.push(truncated
            ? (keepHead ? '\n--- BEGINNING OF THE LOG ---' : '\n--- LAST PART OF THE LOG ---')
            : '\n--- FULL LOG ---');
        out.push(excerpt);

        // Deliberately NOT "END OF LOG" when truncated. That phrasing is what
        // let the bot conclude a user's game had hung.
        out.push(truncated
            ? "=== END OF EXCERPT — this is where Shubba's excerpt stops, NOT where the log stops. Do not treat it as a hang, freeze or crash. ==="
            : '=== END OF LOG — the complete file, nothing was cut. Even so, a log merely ending is not by itself evidence of a hang. ===');

        let result = out.join('\n');
        if (result.length > maxChars) result = result.slice(0, maxChars);
        return result;
    } catch (e) {
        return '--- LOG FILE ---\nShubba could not read this log. Do not guess at its contents.';
    }
}

/**
 * Convenience for whoever wires this into index.js: bytes in, everything out,
 * with the truncation metadata already threaded through so the banner reports
 * the true original size rather than whatever survived our own byte cap.
 *
 * @param {Buffer|Uint8Array|string} buffer
 * @param {string} [filename]
 * @param {{maxChars?:number, source?:string}} [opts]
 */
function analyzeLog(buffer, filename, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    let meta;
    try {
        meta = decompress(buffer, filename);
    } catch (e) {
        meta = { text: '', gzip: false, kept: 'all', inputBytes: 0, decodedBytes: 0, keptBytes: 0, warnings: [] };
    }
    const facts = extractFacts(meta.text);
    const summary = summarizeForPrompt(meta.text, {
        maxChars: o.maxChars,
        source: filename || o.source || null,
        keptPart: meta.kept,
        // decodedBytes is bytes and text.length is characters; for a log
        // (overwhelmingly ASCII) they match closely enough to be honest, and
        // over-reporting the original is the safe direction anyway.
        originalChars: meta.kept === 'all' ? meta.text.length : meta.decodedBytes,
    });
    return { text: meta.text, facts, summary, meta };
}

module.exports = {
    decompressIfNeeded,
    decompress,
    extractFacts,
    summarizeForPrompt,
    isLikelyLog,
    analyzeLog,
    findExceptionIndex,
    LIMITS,
};
