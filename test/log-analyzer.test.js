'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const {
    decompressIfNeeded, decompress, extractFacts, summarizeForPrompt,
    isLikelyLog, analyzeLog, LIMITS,
} = require('../lib/log-analyzer');

// Sample logs are built inline so nothing here depends on files on disk.

const FABRIC_BOOT = [
    '[08:15:22] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.11',
    '[08:15:22] [main/INFO]: Loading 61 mods:',
    '\t- minecraft 1.20.1',
    '\t- java 17',
    '\t- fabricloader 0.15.11',
    '\t- fabric-api 0.92.2+1.20.1',
    '\t   |-- fabric-api-base 0.4.31+1.20.1',
    '\t- punchy 2.7d',
    '\t- sodium 0.5.8',
    '\t- epicfight 20.9.3',
    '[08:15:25] [Render thread/INFO]: Reloading ResourceManager: vanilla, fabric, file/MyPunchyPack.zip',
    '[08:15:26] [Render thread/INFO]: [Iris] Using shaderpack: ComplementaryUnbound_r5.1.zip',
    '[08:15:30] [Render thread/INFO]: Loaded 7 recipes',
].join('\n');

const FORGE_CRASH = [
    '[08:15:22] [main/INFO] [cpw.mods.modlauncher.Launcher/MODLAUNCHER]: ModLauncher running: args [--version, 1.20.1-forge-47.2.0, --gameDir, .]',
    '[08:15:23] [main/INFO] [net.minecraftforge.fml.loading.ImmediateWindowHandler/]: Forge mod loading, version 47.2.0, for MC 1.20.1 with MCP 20230612.114412',
    '[08:15:23] [main/INFO]: Java is OpenJDK 64-Bit Server VM, version 17.0.8+7, running on Windows 11',
    '---- Minecraft Crash Report ----',
    '// Oh - I know what I did wrong!',
    '',
    'Description: Rendering item',
    '',
    'java.lang.NullPointerException: Cannot invoke "ItemStack.getItem()" because "stack" is null',
    '\tat net.minecraft.client.renderer.ItemInHandRenderer.renderArmWithItem(ItemInHandRenderer.java:110)',
    '',
    '-- System Details --',
    'Details:',
    '\tMinecraft Version: 1.20.1',
    '\tJava Version: 17.0.8, Eclipse Adoptium',
    '\tResource Packs: vanilla, file/CoolPack.zip',
    '\tMod List: ',
    '\t\tclient-extra.jar                  |Minecraft      |minecraft   |1.20.1  |COMMON_SET|Manifest: NOSIGNATURE',
    '\t\tforge-1.20.1-47.2.0-universal.jar |Forge          |forge       |47.2.0  |COMMON_SET|Manifest: NOSIGNATURE',
    '\t\tpunchy-2.7d.jar                   |Punchy!        |punchy      |2.7d    |COMMON_SET|Manifest: NOSIGNATURE',
    '\t\tepicfight-20.9.3.jar              |Epic Fight Mod |epicfight   |20.9.3  |COMMON_SET|Manifest: NOSIGNATURE',
].join('\n');

const MIXIN_CRASH = [
    '[09:01:00] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.11',
    '[09:01:00] [main/INFO]: Loading 3 mods:',
    '\t- minecraft 1.20.1',
    '\t- punchy 2.7d',
    '\t- epicfight 20.9.3',
    '[09:01:04] [main/ERROR]: Mixin apply for mod epicfight failed epicfight.mixins.json:MixinItemInHandRenderer from mod epicfight -> net.minecraft.client.renderer.ItemInHandRenderer',
    'Exception in thread "main" java.lang.RuntimeException: Mixin transformation failed',
    '\tat org.spongepowered.asm.mixin.transformer.MixinProcessor.applyMixins(MixinProcessor.java:392)',
    'Caused by: org.spongepowered.asm.mixin.injection.throwables.InjectionError: Critical injection failure',
].join('\n');

// A mixin blow-up with NO "for mod X" anywhere: the owner has to come out of
// the package name, cross-checked against the mod list.
const MIXIN_PACKAGE_ONLY = [
    '[09:01:00] [main/INFO]: Loading Minecraft 1.21.1 with Fabric Loader 0.16.5',
    '[09:01:00] [main/INFO]: Loading 3 mods:',
    '\t- minecraft 1.21.1',
    '\t- punchy 2.8',
    '\t- bettercombat 1.8.5',
    '[09:01:04] [Render thread/ERROR]: Uncaught exception in thread "Render thread"',
    'java.lang.NoSuchMethodError: net.minecraft.class_757.method_1()V',
    '\tat net.bettercombat.mixin.client.HeldItemRendererMixin.handler$abc000(HeldItemRendererMixin.java:44)',
    '\tat net.minecraft.class_757.method_1(class_757.java:1)',
].join('\n');

const CLEAN_LINE = (i) => `[10:00:00] [Render thread/INFO]: chunk ${i} loaded and rendered fine`;
const NOISE = Array.from({ length: 3000 }, (_, i) => CLEAN_LINE(i)).join('\n');

// ── decompressIfNeeded: gzip, plain text, and junk ──────────────────────────

test('gunzips a .log.gz round-trip', () => {
    const gz = zlib.gzipSync(Buffer.from(FABRIC_BOOT, 'utf8'));
    assert.equal(decompressIfNeeded(gz, 'latest.log.gz'), FABRIC_BOOT);
});

test('gunzips on the magic bytes even when the name says otherwise', () => {
    // Some launchers hand out a gzipped file still called latest.log.
    const gz = zlib.gzipSync(Buffer.from(FABRIC_BOOT, 'utf8'));
    assert.equal(decompressIfNeeded(gz, 'latest.log'), FABRIC_BOOT);
    assert.equal(decompressIfNeeded(gz), FABRIC_BOOT);
});

test('passes plain text straight through', () => {
    assert.equal(decompressIfNeeded(Buffer.from(FABRIC_BOOT, 'utf8'), 'latest.log'), FABRIC_BOOT);
});

test('a .gz name over plain bytes still reads as text', () => {
    // The name lies; the bytes do not. Reading it is better than returning ''.
    assert.equal(decompressIfNeeded(Buffer.from('hello world', 'utf8'), 'latest.log.gz'), 'hello world');
});

test('decodes UTF-16, which Windows tooling still produces', () => {
    const u16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(FABRIC_BOOT, 'utf16le')]);
    assert.equal(decompressIfNeeded(u16, 'latest.log'), FABRIC_BOOT);
});

test('never throws on empty, null or nonsense input', () => {
    assert.equal(decompressIfNeeded(Buffer.alloc(0), 'latest.log'), '');
    assert.equal(decompressIfNeeded(null, null), '');
    assert.equal(decompressIfNeeded(undefined), '');
    assert.equal(decompressIfNeeded(12345, {}), '');
    assert.equal(typeof decompressIfNeeded('already a string', 'x.log'), 'string');
});

test('never throws on binary junk or a corrupt .gz', () => {
    const junk = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256));
    assert.equal(typeof decompressIfNeeded(junk, 'latest.log'), 'string');
    // Gzip magic followed by garbage: must degrade, not explode.
    const fakeGz = Buffer.concat([Buffer.from([0x1f, 0x8b]), junk]);
    assert.equal(typeof decompressIfNeeded(fakeGz, 'latest.log.gz'), 'string');
});

test('a .gz cut short still yields what inflated, flagged as missing its end', () => {
    const full = FABRIC_BOOT + '\n' + NOISE;
    const gz = zlib.gzipSync(Buffer.from(full, 'utf8'));
    const meta = decompress(gz.subarray(0, Math.floor(gz.length * 0.7)), 'latest.log.gz');
    assert.ok(meta.text.length > 0, 'a partial gzip stream still has readable content');
    // The END is what went missing, and that is the dangerous direction —
    // it must be recorded so the summary can warn about it.
    assert.equal(meta.kept, 'head');
    assert.ok(meta.warnings.length > 0);
});

// ── isLikelyLog ─────────────────────────────────────────────────────────────

test('recognises the log files Minecraft actually produces', () => {
    for (const name of [
        'latest.log', 'latest.log.gz', 'debug.log', 'debug.log.gz',
        'crash-2026-01-01_10.00.00-client.txt', 'crash-2026-01-01_10.00.00-client.txt.gz',
        '2026-01-01-1.log.gz', 'latest.log.1', 'modlist.txt', 'hs_err_pid4242.log',
    ]) {
        assert.equal(isLikelyLog(name, ''), true, `${name} should read as a log`);
    }
});

test('does not mistake packs, images or configs for logs', () => {
    assert.equal(isLikelyLog('pack.mcmeta', 'text/plain'), false);
    assert.equal(isLikelyLog('compat.json', 'text/plain'), false);
    assert.equal(isLikelyLog('screenshot.png', 'image/png'), false);
    assert.equal(isLikelyLog('MyPack.zip', 'application/zip'), false);
    assert.equal(isLikelyLog('punchy-2.7d.jar', ''), false);
});

test('handles a signed Discord CDN url and odd arguments', () => {
    assert.equal(isLikelyLog('https://cdn.discordapp.com/attachments/1/2/latest.log?ex=a&is=b', ''), true);
    assert.equal(isLikelyLog('paste', 'text/plain'), true);
    assert.equal(isLikelyLog(null, null), false);
    assert.equal(isLikelyLog(undefined), false);
    assert.equal(isLikelyLog({}, []), false);
});

// ── extractFacts: Fabric ────────────────────────────────────────────────────

test('reads a Fabric boot log', () => {
    const f = extractFacts(FABRIC_BOOT);
    assert.equal(f.minecraftVersion, '1.20.1');
    assert.equal(f.loader, 'fabric');
    assert.equal(f.loaderVersion, '0.15.11');
    assert.equal(f.javaVersion, '17');
    assert.equal(f.punchyVersion, '2.7d');
    assert.equal(f.crashed, false);
});

test('reads the Fabric mod list, nested entries included', () => {
    const ids = extractFacts(FABRIC_BOOT).mods.map(m => m.id);
    assert.ok(ids.includes('punchy'), 'punchy must be found in the mod list');
    assert.ok(ids.includes('sodium'));
    assert.ok(ids.includes('epicfight'));
    assert.ok(ids.includes('fabric-api-base'), 'nested "|--" children are mods too');
    const sodium = extractFacts(FABRIC_BOOT).mods.find(m => m.id === 'sodium');
    assert.equal(sodium.version, '0.5.8');
});

test('reads the resource packs and shaderpack out of the log', () => {
    const f = extractFacts(FABRIC_BOOT);
    assert.ok(f.resourcePacks.includes('file/MyPunchyPack.zip'));
    assert.equal(f.shaderpack, 'ComplementaryUnbound_r5.1.zip');
});

// ── extractFacts: Forge ─────────────────────────────────────────────────────

test('reads a Forge crash report', () => {
    const f = extractFacts(FORGE_CRASH);
    assert.equal(f.minecraftVersion, '1.20.1');
    assert.equal(f.loader, 'forge');
    assert.equal(f.loaderVersion, '47.2.0');
    assert.equal(f.javaVersion, '17.0.8');
    assert.equal(f.punchyVersion, '2.7d');
    assert.equal(f.crashed, true);
    assert.equal(f.exceptionType, 'java.lang.NullPointerException');
});

test("reads Forge's pipe-delimited Mod List table", () => {
    const mods = extractFacts(FORGE_CRASH).mods;
    const ids = mods.map(m => m.id);
    assert.ok(ids.includes('punchy'));
    assert.ok(ids.includes('epicfight'));
    assert.equal(mods.find(m => m.id === 'epicfight').version, '20.9.3');
    assert.ok(extractFacts(FORGE_CRASH).resourcePacks.includes('file/CoolPack.zip'));
});

test('tells the loaders apart', () => {
    assert.equal(extractFacts('Loading Minecraft 1.20.1 with Quilt Loader 0.23.1').loader, 'quilt');
    // NeoForge must not be filed as Forge just because the word is in there.
    const neo = extractFacts('ModLauncher running: args [--fml.neoForgeVersion, 21.1.65, --fml.mcVersion, 1.21.1]');
    assert.equal(neo.loader, 'neoforge');
    assert.equal(neo.loaderVersion, '21.1.65');
    assert.equal(neo.minecraftVersion, '1.21.1');
});

// ── Mixin attribution: "this is not our bug", with evidence ─────────────────

test('attributes a failing mixin to the mod that owns it', () => {
    const f = extractFacts(MIXIN_CRASH);
    assert.equal(f.failingMixin, 'epicfight.mixins.json:MixinItemInHandRenderer');
    assert.equal(f.failingMod, 'epicfight');
    assert.equal(f.crashed, true);
    assert.equal(f.exceptionType, 'org.spongepowered.asm.mixin.injection.throwables.InjectionError');
});

test('attributes a mixin from its package when the loader never names a mod', () => {
    // The stack looks like a Minecraft (or Punchy) problem; the owning mod is
    // only visible in the package, cross-checked against the mod list.
    const f = extractFacts(MIXIN_PACKAGE_ONLY);
    assert.equal(f.failingMixin, 'net.bettercombat.mixin.client.HeldItemRendererMixin');
    assert.equal(f.failingMod, 'bettercombat');
    assert.notEqual(f.failingMod, 'punchy');
});

test('never blames a generic package segment', () => {
    const f = extractFacts('\tat net.minecraft.client.mixin.Foo.bar(Foo.java:1)');
    assert.ok(f.failingMod === null || !['net', 'client', 'minecraft', 'com', 'org'].includes(f.failingMod));
});

test('a clean log is not reported as a crash', () => {
    const f = extractFacts(FABRIC_BOOT);
    assert.equal(f.crashed, false);
    assert.equal(f.failingMixin, null);
    assert.equal(f.failingMod, null);
});

test('extractFacts survives junk and returns the full shape', () => {
    for (const input of [undefined, null, '', 42, {}, [], ' binary�']) {
        const f = extractFacts(input);
        assert.equal(typeof f, 'object');
        assert.equal(f.crashed, false);
        assert.deepEqual(f.mods, []);
        assert.deepEqual(f.resourcePacks, []);
        assert.equal(f.minecraftVersion, null);
        assert.equal(f.loader, null);
        assert.equal(f.failingMod, null);
    }
});

// ── Truncation: the failure this module exists to prevent ───────────────────
//
// Shubba once told a user their game had HUNG because the log "ends" mid-line.
// It had not ended — that was index.js's own substring(0, 50000). These are the
// tests that keep that from happening again.

const LONG_LOG = FABRIC_BOOT + '\n' + NOISE + '\n' + [
    '[10:30:00] [main/ERROR]: Mixin apply for mod epicfight failed epicfight.mixins.json:MixinItemInHandRenderer from mod epicfight -> net.minecraft.client.renderer.ItemInHandRenderer',
    'Exception in thread "main" java.lang.RuntimeException: Mixin transformation failed',
    'Caused by: org.spongepowered.asm.mixin.injection.throwables.InjectionError: Critical injection failure',
].join('\n');

test('a truncated summary says out loud that it is truncated', () => {
    const s = summarizeForPrompt(LONG_LOG, { maxChars: 3000 });
    assert.match(s, /\[log truncated: showing the last \d+ of \d+ characters/);
    assert.ok(s.includes('the beginning is NOT included'));
    assert.ok(s.includes('do not infer anything from where this starts'));
});

test('a truncated summary never claims the log ended', () => {
    const s = summarizeForPrompt(LONG_LOG, { maxChars: 3000 });
    // This is the exact phrasing the bot read as "the game stopped here".
    assert.ok(!s.includes('END OF LOG'), 'a truncated excerpt must never be signed off as the end of the log');
    assert.ok(s.includes('END OF EXCERPT'));
    assert.ok(s.includes('NOT where the log stops'));
});

test('a truncated summary keeps the TAIL, not the head', () => {
    const s = summarizeForPrompt(LONG_LOG, { maxChars: 3000 });
    assert.ok(s.includes('Critical injection failure'), 'the end of the log is the part worth keeping');
    // The boot header is the first thing in the file and must be the first
    // thing dropped — a head-first cut would have thrown away the crash.
    assert.ok(!s.includes('[08:15:22] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.11'));
});

test('the facts survive truncation even when their source lines are cut away', () => {
    // The whole point: facts are parsed from the FULL log, the excerpt is only
    // the tail. Losing the boot header must not lose the boot facts.
    const s = summarizeForPrompt(LONG_LOG, { maxChars: 3000 });
    assert.ok(s.includes('Minecraft: 1.20.1'));
    assert.ok(s.includes('Loader: fabric 0.15.11'));
    assert.ok(s.includes('Mixin owner: epicfight'));
});

test('an untruncated summary is allowed to say END OF LOG, and says it is complete', () => {
    const s = summarizeForPrompt(FABRIC_BOOT, { maxChars: 20000 });
    assert.ok(!s.includes('[log truncated'), 'nothing was cut, so nothing should claim it was');
    assert.ok(s.includes('END OF LOG'));
    assert.ok(s.includes('nothing was cut'));
    assert.ok(s.includes('Loading 61 mods:'), 'a short log is shown whole');
});

test('an upstream cut is reported with the real original size', () => {
    // index.js already does substring(0, 50000); when it passes the true size
    // along, the banner must quote that, not the length of what survived.
    const s = summarizeForPrompt('tail of the log\nlast line', { maxChars: 20000, originalChars: 4200000 });
    assert.match(s, /showing the last \d+ of 4200000 characters/);
    assert.ok(!s.includes('END OF LOG'));
});

test('when only the HEAD survived, the summary warns the END is missing', () => {
    // The dangerous direction: a cut-off upload looks exactly like a game that
    // froze. Say so explicitly instead of letting the model guess.
    const s = summarizeForPrompt(LONG_LOG, { maxChars: 2000, keptPart: 'head' });
    assert.match(s, /\[log truncated: showing the first \d+ of \d+ characters/);
    assert.ok(s.includes('the END is NOT included'));
    assert.ok(s.includes('Never diagnose a hang, freeze or shutdown'));
    assert.ok(!s.includes('END OF LOG'));
});

test('an exception earlier than the tail window is carried forward', () => {
    const s = summarizeForPrompt(FABRIC_BOOT + '\n' + MIXIN_CRASH + '\n' + NOISE, { maxChars: 3000 });
    assert.ok(s.includes('EXCEPTION / STACK TRACE'));
    assert.ok(s.includes('Critical injection failure'), 'an excerpt without the exception is useless');
});

test('summarizeForPrompt stays under maxChars, default and explicit', () => {
    assert.ok(summarizeForPrompt(LONG_LOG).length <= LIMITS.DEFAULT_MAX_CHARS);
    for (const n of [400, 500, 1000, 5000, 20000]) {
        const s = summarizeForPrompt(LONG_LOG, { maxChars: n });
        assert.ok(s.length <= n, `maxChars ${n} produced ${s.length} chars`);
        assert.ok(s.includes('[log truncated'), `maxChars ${n} truncates and must say so`);
    }
});

test('an absurd maxChars is clamped rather than obeyed into uselessness', () => {
    const s = summarizeForPrompt(LONG_LOG, { maxChars: 1 });
    assert.equal(s.length, LIMITS.MIN_MAX_CHARS);
    assert.ok(s.includes('[log truncated'), 'even the smallest excerpt admits it is one');
});

test('summarizeForPrompt never throws and never invents content', () => {
    for (const input of [undefined, null, '', '   \n  ', 42, {}, []]) {
        const s = summarizeForPrompt(input, { maxChars: 5000 });
        assert.equal(typeof s, 'string');
        assert.ok(s.includes('Do not guess'), 'an unreadable file must tell the model not to guess');
    }
    assert.equal(typeof summarizeForPrompt(FABRIC_BOOT, null), 'string');
    assert.equal(typeof summarizeForPrompt(FABRIC_BOOT, { maxChars: NaN }), 'string');
});

// ── Size ────────────────────────────────────────────────────────────────────

test('a log far larger than the cap is read from the tail and flagged', () => {
    const filler = Buffer.alloc(LIMITS.MAX_TEXT_BYTES + 1024 * 1024, 0x41); // 'A'
    const huge = Buffer.concat([
        Buffer.from(FABRIC_BOOT + '\n', 'utf8'),
        filler,
        Buffer.from('\n[10:30:00] [main/ERROR]: the very last line\n', 'utf8'),
    ]);
    const r = analyzeLog(huge, 'latest.log', { maxChars: 4000 });
    assert.equal(r.meta.kept, 'tail', 'the end of a huge log is the part to keep');
    assert.ok(r.meta.keptBytes <= LIMITS.MAX_TEXT_BYTES);
    assert.ok(r.meta.warnings.length > 0, 'dropping most of a file must be recorded');
    assert.ok(r.summary.includes('[log truncated'));
    assert.ok(r.summary.includes('the very last line'));
    assert.ok(!r.summary.includes('END OF LOG'));
});

test('analyzeLog wires bytes straight through to a summary', () => {
    const gz = zlib.gzipSync(Buffer.from(MIXIN_CRASH, 'utf8'));
    const r = analyzeLog(gz, 'latest.log.gz');
    assert.equal(r.meta.gzip, true);
    assert.equal(r.facts.failingMod, 'epicfight');
    assert.ok(r.summary.includes('Mixin owner: epicfight'));
    assert.equal(typeof analyzeLog(null, null).summary, 'string');
});
