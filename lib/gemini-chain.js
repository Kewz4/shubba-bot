/**
 * gemini-chain.js — resilient multi-model Gemini executor.
 *
 * Why this exists:
 *   The old code called ONE hardcoded model and, on a 429 (quota) or 5xx,
 *   just retried the SAME model with backoff — so when a model hit its daily
 *   free-tier cap, Shubba went down for the rest of the day. Google's free tier
 *   gives a SEPARATE quota bucket per model, so the highest-leverage reliability
 *   win is to fall over to a different model on the same key.
 *
 *   runGeminiChain() walks an ordered list of models. On a per-day quota 429 it
 *   parks that model until the next UTC midnight and moves to the next one; on a
 *   per-minute 429 it parks it briefly; on 404 (model not enabled on this key)
 *   it drops the model permanently for the process; a real 400 aborts loudly so
 *   bugs aren't masked. This multiplies the effective free daily budget without
 *   leaving Google or touching any call site.
 *
 * Everything here is dependency-injected (http post fn, clock, limiter) so it is
 * unit-testable with no network — see test/gemini-chain.test.js.
 */

'use strict';

/** Parse a comma/whitespace separated model list, dropping blanks & dupes.
 *  An optional `primary` (e.g. a legacy single-model env var) is prepended.
 *  Returns [] for empty input so the caller can fall back to its own defaults. */
function parseChain(envValue, primary) {
    const out = [];
    const push = (m) => {
        const t = (m || '').trim();
        if (t && !out.includes(t)) out.push(t);
    };
    if (primary) push(primary);
    if (envValue) String(envValue).split(/[,\s]+/).forEach(push);
    return out;
}

/** First instant of the next UTC day, in epoch ms — used to park a model that
 *  has exhausted its per-DAY free quota until the quota resets at 00:00 UTC. */
function nextUtcMidnight(nowMs) {
    const d = new Date(nowMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

/** Classify a Gemini/axios error into a routing decision.
 *  Returns { kind, scope } where kind ∈
 *    'rate'        → 429; scope 'day' | 'minute' decides cooldown length
 *    'not_found'   → model not available on this key (404 / NOT_FOUND / unsupported)
 *    'bad_request' → 400 malformed prompt/config — a real bug, abort the chain
 *    'transient'   → 5xx / network / timeout — retry same model, then move on
 *    'auth'        → 401/403 — key problem, abort the chain (no model will work)
 */
function classifyError(err) {
    const status = err && err.response && err.response.status;
    const body = (err && err.response && err.response.data && err.response.data.error) || {};
    const msg = String(body.message || (err && err.message) || '').toLowerCase();
    const details = JSON.stringify(body.details || []).toLowerCase();
    const blob = msg + ' ' + details;

    if (status === 429) {
        // Per-day quota exhaustion mentions a "PerDay" quotaId; per-minute mentions "PerMinute".
        const isDay = /perday|per day|requests per day|\brpd\b|daily/.test(blob) && !/perminute|per minute/.test(blob);
        return { kind: 'rate', scope: isDay ? 'day' : 'minute' };
    }
    if (status === 404 || /not found|is not supported|does not exist|not available|unsupported/.test(blob)) {
        return { kind: 'not_found' };
    }
    if (status === 401 || status === 403) return { kind: 'auth' };
    if (status === 400) return { kind: 'bad_request' };
    if (status && status >= 400 && status < 500) return { kind: 'bad_request' };
    return { kind: 'transient' };
}

/** Pull the answer text out of a generateContent response, skipping any
 *  "thought" parts that thinking-enabled models emit before the real answer. */
function extractText(data) {
    const cand = data && data.candidates && data.candidates[0];
    const parts = cand && cand.content && cand.content.parts;
    if (!parts || !parts.length) {
        const reason = cand && cand.finishReason;
        throw new Error('Empty Gemini response' + (reason ? ` (finishReason: ${reason})` : ''));
    }
    const answer = parts.slice().reverse().find((p) => !p.thought && p.text) || parts[parts.length - 1];
    if (!answer || !answer.text) throw new Error('Gemini response had no text part');
    return answer.text;
}

/**
 * Create a chain runner bound to a config.
 * @param {object} cfg
 * @param {string} cfg.apiKey            Gemini API key.
 * @param {function} [cfg.httpPost]      (url, body, opts) => Promise<{data}>. Defaults to axios.post.
 * @param {function} [cfg.now]           () => epoch ms. Injectable clock for tests.
 * @param {object}   [cfg.limiter]       { waitForSlot() } RPM pacer. Optional.
 * @param {function} [cfg.log]           (msg) => void.
 * @param {number}   [cfg.minuteCooldownMs] Cooldown for a per-minute 429 (default 60s).
 */
function createGeminiRunner(cfg) {
    const {
        apiKey,
        httpPost = require('axios').post,
        now = Date.now,
        limiter = null,
        log = () => {},
        minuteCooldownMs = 60 * 1000,
    } = cfg || {};

    // model → epoch ms until which the model should be skipped.
    const cooldownUntil = Object.create(null);
    const FAR_FUTURE = 8640000000000000; // permanent skip (model not on this key)

    function available(models) {
        const t = now();
        return models.filter((m) => !(cooldownUntil[m] > t));
    }

    function buildUrl(model) {
        return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    }

    /**
     * @param {string} prompt
     * @param {object} opts
     * @param {string[]} opts.models    Ordered model chain.
     * @param {object}   opts.genConfig generationConfig for the request.
     * @param {number}   [opts.timeout] axios timeout ms.
     * @param {string}   [opts.label]   log label.
     * @param {number}   [opts.perModelRetries] transient retries per model (default 1).
     */
    async function runGeminiChain(prompt, opts) {
        const { models, genConfig, timeout = 120000, label = 'gemini', perModelRetries = 1 } = opts;
        const usable = available(models);
        const tried = usable.length ? usable : models; // if all cooled down, try anyway (better than nothing)

        let lastErr;
        for (const model of tried) {
            let attempt = 0;
            // transient retries happen inside this while; quota/notfound break out.
            // eslint-disable-next-line no-constant-condition
            while (true) {
                try {
                    if (limiter && limiter.waitForSlot) await limiter.waitForSlot();
                    log(`🤖 ${label}: ${model}${attempt ? ` (retry ${attempt})` : ''}`);
                    const res = await httpPost(
                        buildUrl(model),
                        { contents: [{ parts: [{ text: prompt }] }], generationConfig: genConfig },
                        { timeout, maxContentLength: 100 * 1024 * 1024 }
                    );
                    return { text: extractText(res.data), model };
                } catch (err) {
                    lastErr = err;
                    const c = classifyError(err);
                    const apiMsg =
                        (err.response && err.response.data && err.response.data.error &&
                            err.response.data.error.message) || err.message || '';

                    if (c.kind === 'auth') {
                        log(`🔴 ${label}: auth error on ${model} — aborting chain: ${apiMsg}`);
                        throw err; // no model will work with a bad/blocked key
                    }
                    if (c.kind === 'bad_request') {
                        log(`🔴 ${label}: 400 bad request on ${model} — aborting: ${apiMsg}`);
                        throw err; // a real bug; masking it by rotating would hide it
                    }
                    if (c.kind === 'not_found') {
                        cooldownUntil[model] = FAR_FUTURE;
                        log(`⏭️ ${label}: ${model} not available on this key — dropping it. ${apiMsg}`);
                        break; // next model
                    }
                    if (c.kind === 'rate') {
                        cooldownUntil[model] =
                            c.scope === 'day' ? nextUtcMidnight(now()) : now() + minuteCooldownMs;
                        log(`⏳ ${label}: ${model} rate-limited (${c.scope}) — parking, next model. ${apiMsg}`);
                        break; // next model
                    }
                    // transient
                    if (attempt < perModelRetries) {
                        attempt++;
                        const delay = attempt * 2000;
                        log(`⚠️ ${label}: transient on ${model} (${apiMsg || err.message}) — retry in ${delay}ms`);
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }
                    log(`⚠️ ${label}: ${model} failed after retries — next model. ${apiMsg || err.message}`);
                    break; // next model
                }
            }
        }
        const e = new Error(`All models exhausted for ${label}: [${tried.join(', ')}]`);
        e.cause = lastErr;
        e.allModelsExhausted = true;
        throw e;
    }

    return { runGeminiChain, _cooldownUntil: cooldownUntil };
}

module.exports = {
    parseChain,
    nextUtcMidnight,
    classifyError,
    extractText,
    createGeminiRunner,
};
