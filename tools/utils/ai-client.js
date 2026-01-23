require('dotenv').config();

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function redactKey(k) {
  if (!k) return null;
  const s = String(k);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function extractJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;

  // Remove ```json fences if present
  const cleaned = text
    .replace(/```json\s*/gi, '```')
    .replace(/```/g, '')
    .trim();

  // Fast path: whole string JSON
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // continue
  }

  // Best-effort: first { ... } block
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const slice = cleaned.slice(first, last + 1);
    try {
      return JSON.parse(slice);
    } catch (_) {
      return null;
    }
  }

  return null;
}

async function fileToDataUrl(filePath, mime = 'image/png') {
  const abs = path.resolve(filePath);
  const buf = await fs.readFile(abs);
  const b64 = buf.toString('base64');
  return `data:${mime};base64,${b64}`;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) throw new Error('messages must be an array');
  return messages.map((m) => {
    if (!m || typeof m !== 'object') throw new Error('message must be an object');
    if (!m.role) throw new Error('message.role is required');
    return m;
  });
}

function createOpenRouterClient({
  apiKey = process.env.OPENROUTER_API_KEY,
  baseUrl = OPENROUTER_BASE_URL,
  httpReferer = process.env.OPENROUTER_HTTP_REFERER,
  xTitle = process.env.OPENROUTER_X_TITLE,
  timeoutMs = 120000,
} = {}) {
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is missing (set it in .env)');
  }

  const client = axios.create({
    baseURL: baseUrl,
    timeout: timeoutMs,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(httpReferer ? { 'HTTP-Referer': httpReferer } : {}),
      ...(xTitle ? { 'X-Title': xTitle } : {}),
    },
  });

  async function requestWithRetry(fn, { retries = 3 } = {}) {
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        const status = e?.response?.status;
        const retryable = status === 429 || (status >= 500 && status <= 599);
        if (!retryable || i === retries) break;
        const backoff = 750 * Math.pow(2, i);
        await sleep(backoff);
      }
    }
    throw lastErr;
  }

  async function chatCompletions({
    model,
    messages,
    temperature = 0.2,
    max_tokens = 1800,
    response_format = null,
    // OpenRouter supports OpenAI-compatible params; keep pass-through minimal by default.
    extra = {},
  } = {}) {
    if (!model) throw new Error('model is required');
    const msgs = normalizeMessages(messages);

    const payload = {
      model,
      messages: msgs,
      temperature,
      max_tokens,
      ...(response_format ? { response_format } : {}),
      ...extra,
    };

    const res = await requestWithRetry(
      () => client.post('/chat/completions', payload),
      { retries: 3 }
    );

    const data = res?.data;
    const choice = (data?.choices || [])[0] || null;
    const content = choice?.message?.content ?? null;
    const usage = data?.usage || null;
    return { content, usage, raw: data };
  }

  async function chatJson({
    model,
    messages,
    temperature = 0.0,
    max_tokens = 1800,
    // If model supports JSON mode, this helps; we still best-effort extract.
    enforceJson = true,
    extra = {},
  } = {}) {
    const response_format = enforceJson ? { type: 'json_object' } : null;

    let content, usage, raw;
    try {
      ({ content, usage, raw } = await chatCompletions({
        model,
        messages,
        temperature,
        max_tokens,
        response_format,
        extra,
      }));
    } catch (e) {
      // Some providers/models reject response_format (JSON mode) with 400.
      // Fallback: retry once without response_format and best-effort parse JSON from text.
      const status = e?.response?.status;
      if (enforceJson && status === 400) {
        ({ content, usage, raw } = await chatCompletions({
          model,
          messages,
          temperature,
          max_tokens,
          response_format: null,
          extra,
        }));
      } else {
        if (status === 400 && e?.response?.data) {
          console.warn('⚠️ 400 Error Validation Details:', JSON.stringify(e.response.data, null, 2));
        }
        throw e;
      }
    }
    const text = typeof content === 'string' ? content : safeStringifyContent(content);
    const json = extractJsonFromText(text);
    return { text, json, usage, raw };
  }

  function safeStringifyContent(content) {
    // Some providers return multimodal content arrays; stringify for logging/debug.
    try {
      if (typeof content === 'string') return content;
      return JSON.stringify(content);
    } catch (_) {
      return String(content);
    }
  }

  async function listModels() {
    const res = await requestWithRetry(() => client.get('/models'), { retries: 2 });
    return res?.data || null;
  }

  return {
    baseUrl,
    apiKeyHint: redactKey(apiKey),
    chatCompletions,
    chatJson,
    listModels,
    fileToDataUrl,
    extractJsonFromText,
  };
}

module.exports = { createOpenRouterClient };

