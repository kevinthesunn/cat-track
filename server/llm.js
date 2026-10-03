// AI provider layer. Cat Track runs fully offline (rule engine) when no provider is configured.
// Providers, in order of precedence:
//   1. Any OpenAI-compatible endpoint: AI_BASE_URL + AI_API_KEY + AI_MODEL (Groq, NVIDIA, …).
//      AI_DOC_MODEL optionally names a second model for document integration.
//   2. Anthropic: ANTHROPIC_API_KEY (model CAT_TRACK_MODEL, default claude-opus-5-5)
import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { toFile } from 'openai';

const CLAUDE_MODEL = process.env.CAT_TRACK_MODEL || 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function provider() {
  if (process.env.CAT_TRACK_DISABLE_LLM === '1') return null;
  if (process.env.AI_BASE_URL && process.env.AI_API_KEY && process.env.AI_MODEL) return 'openai';
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'anthropic';
  return null;
}
export const llmEnabled = () => provider() !== null;
export function llmInfo() {
  const p = provider();
  if (p === 'openai') {
    let host = process.env.AI_BASE_URL;
    try { host = new URL(process.env.AI_BASE_URL).host; } catch { /* keep raw */ }
    return { provider: 'openai-compatible', host, model: process.env.AI_MODEL, label: process.env.AI_MODEL.split('/').pop() };
  }
  if (p === 'anthropic') return { provider: 'anthropic', host: 'api.anthropic.com', model: CLAUDE_MODEL, label: CLAUDE_MODEL };
  return { provider: null, host: null, model: null, label: 'offline rule engine' };
}

/* ----------------------------- shared helpers ----------------------------- */

/** Strip reasoning tags some open models leave in `content`. */
const cleanText = (s) => String(s || '')
  .replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*<think>[\s\S]*$/i, '')
  .replace(/【\s*([RD]\d+)[^】]*】/g, '[$1]') // some models cite as 【D2†L3】; normalise to [D2]
  .trim();

/** Parse a JSON object out of model text that may include code fences or stray prose. */
function parseJsonLoose(text) {
  const t = cleanText(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('Model did not return JSON');
}

function runTool(name, input, handlers, ctx) {
  const handler = handlers[name];
  try {
    if (!handler) throw new Error(`Unknown tool ${name}`);
    if (typeof input !== 'object' || input === null) throw new Error('Tool input must be a JSON object');
    const output = handler(input, ctx);
    return { output, isError: Boolean(output && output.error) };
  } catch (err) { return { output: { error: err.message }, isError: true }; }
}

/* --------------------------- OpenAI-compatible --------------------------- */

let oa = null;
// Retries cover rate limits (the SDK waits out a 429's retry-after) as well as transient errors.
const RETRIES = Number(process.env.AI_MAX_RETRIES ?? 2);
const oaClient = () => (oa ||= new OpenAI({ baseURL: process.env.AI_BASE_URL, apiKey: process.env.AI_API_KEY, timeout: 45_000, maxRetries: RETRIES }));
const host = () => { try { return new URL(process.env.AI_BASE_URL).host; } catch { return ''; } };
export const docModel = () => (provider() === 'openai' ? process.env.AI_DOC_MODEL || process.env.AI_MODEL : CLAUDE_MODEL);

/**
 * Per-model request extras. Reasoning models think before answering, which costs time and tokens;
 * keep it short unless AI_REASONING=on. AI_EXTRA_BODY (JSON) is merged last for anything else.
 */
function extraParams(model) {
  const extra = {};
  if (process.env.AI_REASONING !== 'on') {
    if (/nvidia\.com$/.test(host())) extra.chat_template_kwargs = { enable_thinking: false };
    if (/gpt-oss/.test(model)) extra.reasoning_effort = 'low';
  }
  try { Object.assign(extra, JSON.parse(process.env.AI_EXTRA_BODY || '{}')); } catch { console.warn('[llm] AI_EXTRA_BODY is not valid JSON; ignored'); }
  return extra;
}

/** chat.completions.create with graceful degradation if the endpoint rejects optional params. */
async function oaCreate(params, options) {
  const model = params.model || process.env.AI_MODEL;
  const extras = extraParams(model);
  const body = { ...extras, ...params, model };
  try {
    return await oaClient().chat.completions.create(body, options);
  } catch (err) {
    if (err instanceof OpenAI.BadRequestError && (Object.keys(extras).length || body.response_format)) {
      const plain = { ...params, model };
      delete plain.response_format;
      console.warn('[llm] endpoint rejected optional params, retrying plain:', err.message);
      return await oaClient().chat.completions.create(plain, options);
    }
    throw err;
  }
}

async function oaStructured({ system, text, image, schema, maxTokens, timeoutMs, model }) {
  const content = image && process.env.AI_VISION === '1'
    ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } }]
    : text;
  const res = await oaCreate({
    messages: [
      { role: 'system', content: `${system}\n\nRespond with ONLY a JSON object — no prose, no code fences — that validates against this JSON Schema:\n${JSON.stringify(schema)}` },
      { role: 'user', content },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: Math.min(maxTokens, 4000),
    ...(model ? { model } : {}),
  }, { timeout: timeoutMs });
  const choice = res.choices[0];
  if (choice.finish_reason === 'length') throw new Error('Model response truncated');
  return parseJsonLoose(choice.message.content);
}

async function oaComplete({ system, prompt, maxTokens, timeoutMs, model }) {
  const res = await oaCreate({ messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], temperature: 0.3, max_tokens: Math.min(maxTokens, 3000), ...(model ? { model } : {}) }, { timeout: timeoutMs });
  return cleanText(res.choices[0].message.content);
}

async function oaToolAgent({ system, question, tools, handlers, ctx, maxTurns }) {
  const oaTools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const messages = [{ role: 'system', content: system }, { role: 'user', content: question }];
  const trace = [];
  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await oaCreate({ messages, tools: oaTools, tool_choice: 'auto', temperature: 0.3, max_tokens: 1500 }, { timeout: 45_000 });
    const msg = res.choices[0].message;
    const calls = msg.tool_calls || [];
    if (!calls.length) return { answer: cleanText(msg.content) || '(no answer)', trace };
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
    for (const call of calls) {
      let input = null;
      try { input = JSON.parse(call.function.arguments || '{}'); } catch { input = null; }
      const { output, isError } = runTool(call.function.name, input, handlers, ctx);
      trace.push({ tool: call.function.name, input, ok: !isError });
      // Kept compact: free-tier endpoints meter tokens per minute and the whole history is resent each turn.
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output).slice(0, 6000) });
    }
  }
  // Out of tool turns: make it answer from what it has gathered.
  const res = await oaCreate({ messages: [...messages, { role: 'user', content: 'Answer my question now using only what the tools returned.' }], temperature: 0.3, max_tokens: 1200 }, { timeout: 45_000 });
  return { answer: cleanText(res.choices[0].message.content) || '(no answer)', trace };
}

/* -------------------------------- Anthropic -------------------------------- */

let an = null;
const anClient = () => (an ||= new Anthropic({ timeout: 45_000, maxRetries: 1 }));

/** Messages API with server-side refusal fallbacks; retries on the plain endpoint if the beta is rejected. */
async function anCreate(params, options = undefined) {
  try {
    return await anClient().beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, options);
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError) {
      console.warn('[llm] beta request rejected, retrying without fallbacks:', err.message);
      return await anClient().messages.create(params, options);
    }
    throw err;
  }
}
const anText = (message) => (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

async function anStructured({ system, text, image, schema, maxTokens, timeoutMs }) {
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
  content.push({ type: 'text', text });
  const message = await anCreate({
    model: CLAUDE_MODEL, max_tokens: maxTokens, system,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  }, { timeout: timeoutMs, maxRetries: 0 });
  if (message.stop_reason === 'refusal') throw new Error('Model declined this request');
  if (message.stop_reason === 'max_tokens') throw new Error('Model response truncated');
  return JSON.parse(anText(message));
}

async function anComplete({ system, prompt, maxTokens, timeoutMs }) {
  const res = await anCreate({ model: CLAUDE_MODEL, max_tokens: maxTokens, output_config: { effort: 'medium' }, system, messages: [{ role: 'user', content: prompt }] }, { timeout: timeoutMs, maxRetries: 0 });
  if (res.stop_reason === 'refusal') throw new Error('Model declined this request');
  return anText(res);
}

async function anToolAgent({ system, question, tools, handlers, ctx, maxTurns }) {
  const messages = [{ role: 'user', content: question }];
  const trace = [];
  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await anCreate({ model: CLAUDE_MODEL, max_tokens: 8000, system, tools, tool_choice: { type: 'auto' }, output_config: { effort: 'medium' }, messages });
    if (res.stop_reason === 'refusal') return { answer: 'Sorry — I can’t help with that request.', trace };
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason !== 'tool_use') return { answer: anText(res) || '(no answer)', trace };
    const results = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      const { output, isError } = runTool(block.name, block.input, handlers, ctx);
      trace.push({ tool: block.name, input: block.input, ok: !isError });
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(output).slice(0, 12000), is_error: isError });
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'I gathered a lot of context but ran out of steps — try a narrower question.', trace };
}

/* --------------------------------- public --------------------------------- */

/** JSON matching `schema` for a text (+ optional image) prompt. */
// Shared endpoints can queue a request for a minute before generating, so callers run these in
// the background (the rule engine answers first) and allow a generous timeout.
export const BACKGROUND_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 120_000;
export function structured({ system, text, image = null, schema, maxTokens = 8000, timeoutMs = BACKGROUND_TIMEOUT_MS, model = null }) {
  return provider() === 'openai' ? oaStructured({ system, text, image, schema, maxTokens, timeoutMs, model }) : anStructured({ system, text, image, schema, maxTokens, timeoutMs });
}
/** Plain text completion. */
export function complete({ system, prompt, maxTokens = 6000, timeoutMs = BACKGROUND_TIMEOUT_MS, model = null }) {
  return provider() === 'openai' ? oaComplete({ system, prompt, maxTokens, timeoutMs, model }) : anComplete({ system, prompt, maxTokens, timeoutMs });
}
/** 'tools' runs the multi-turn tool loop; 'rag' gathers context up front and makes one call (one queue wait). */
export const agentMode = () => process.env.AI_AGENT_MODE || (provider() === 'openai' && !/groq\.com$/.test(host()) ? 'rag' : 'tools');
/** How much gathered context to send in one call (free tiers meter tokens per minute). */
export const contextChars = () => Number(process.env.AI_CONTEXT_CHARS) || 12_000;
/** Tool-using agent loop over `tools` (Anthropic-style definitions) executed by `handlers`. */
export function runToolAgent({ system, question, tools, handlers, ctx, maxTurns }) {
  return provider() === 'openai'
    ? oaToolAgent({ system, question, tools, handlers, ctx, maxTurns: maxTurns ?? 4 })
    : anToolAgent({ system, question, tools, handlers, ctx, maxTurns: maxTurns ?? 6 });
}

export function describeLlmError(err) {
  if (err instanceof OpenAI.AuthenticationError || err instanceof Anthropic.AuthenticationError) return 'invalid API key';
  if (err instanceof OpenAI.RateLimitError || err instanceof Anthropic.RateLimitError) return 'rate limited';
  if (err instanceof OpenAI.APIConnectionTimeoutError || err instanceof Anthropic.APIConnectionTimeoutError) return 'timed out';
  if (err instanceof OpenAI.APIConnectionError || err instanceof Anthropic.APIConnectionError) return 'network error';
  if (err instanceof OpenAI.APIError || err instanceof Anthropic.APIError) return `API error ${err.status}`;
  return err?.message || String(err);
}

/* ----------------------------- speech to text ----------------------------- */
// Phones record audio and the server transcribes it. Groq hosts Whisper on the same key as the
// chat model; any other OpenAI-compatible host can opt in with AI_STT_MODEL. AI_STT_MODEL=off disables it.
export function sttInfo() {
  if (provider() !== 'openai' || process.env.AI_STT_MODEL === 'off') return null;
  const model = process.env.AI_STT_MODEL || (/groq\.com$/.test(host()) ? 'whisper-large-v3-turbo' : null);
  return model ? { model, host: host() } : null;
}

import { STT } from './i18n.js';

// Part names, codes and machine words Whisper should expect (it biases towards the prompt's vocabulary).
const STT_PROMPT = 'Caterpillar job site report. Cat 336, 777, D6, 966, 140 motor grader. EX-0412, HT-0761, DZ-0107, WL-0233. ' + STT.en.prompt;
// Whisper's well-known inventions on silence or noise.
const HALLUCINATION = /^(thank you( for watching)?|thanks for watching|you|bye|\.|okay\.?|subtitles by .*)[.!]?$/i;

export async function transcribe(buffer, mime = 'audio/webm', lang = 'en') {
  const info = sttInfo();
  if (!info) throw Object.assign(new Error('Speech to text is not set up on this server.'), { status: 503 });
  if (!buffer?.length) throw Object.assign(new Error('No audio received.'), { status: 400 });
  const type = String(mime).split(';')[0].trim() || 'audio/webm';
  const ext = /mp4|m4a|aac/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : /wav/.test(type) ? 'wav' : /mpeg|mp3/.test(type) ? 'mp3' : 'webm';
  const stt = STT[lang] || STT.en;
  const started = Date.now();
  const r = await oaClient().audio.transcriptions.create({
    file: await toFile(buffer, `speech.${ext}`, { type }),
    model: info.model, language: stt.code, prompt: lang === 'en' ? STT_PROMPT : stt.prompt, temperature: 0, response_format: 'json',
  });
  let text = cleanText(r?.text || '').replace(/\s+/g, ' ').trim();
  if (HALLUCINATION.test(text)) text = '';
  return { text, model: info.model, seconds: Math.round((Date.now() - started) / 100) / 10 };
}
