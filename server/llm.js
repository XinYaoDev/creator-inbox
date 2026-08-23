'use strict';

function isKimiK3(model) {
  return /^(k3|kimi-k3)\b/i.test(String(model || ''));
}

function parseLlmJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const s = (fenced ? fenced[1] : raw).trim();
  const start = s.search(/[\[{]/);
  if (start < 0) throw new Error('模型没有返回 JSON');
  return JSON.parse(s.slice(start));
}

function llmConfig() {
  const baseOverride = (process.env.NOTE_LLM_BASE_URL || '').replace(/\/$/, '');
  const modelOverride = process.env.NOTE_LLM_MODEL || '';
  if (process.env.NOTE_LLM_KEY) {
    return {
      key: process.env.NOTE_LLM_KEY,
      base: baseOverride || 'https://api.kimi.com/coding/v1',
      model: modelOverride || 'k3',
    };
  }
  if (process.env.KIMI_API_KEY) {
    return {
      key: process.env.KIMI_API_KEY,
      base: baseOverride || 'https://api.kimi.com/coding/v1',
      model: modelOverride || 'k3',
    };
  }
  if (process.env.MOONSHOT_API_KEY) {
    return {
      key: process.env.MOONSHOT_API_KEY,
      base: baseOverride || 'https://api.moonshot.cn/v1',
      model: modelOverride || 'kimi-k3',
    };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      key: process.env.DEEPSEEK_API_KEY,
      base: baseOverride || 'https://api.deepseek.com/v1',
      model: modelOverride || 'deepseek-chat',
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      key: process.env.OPENAI_API_KEY,
      base: baseOverride || 'https://api.openai.com/v1',
      model: modelOverride || 'gpt-4o-mini',
    };
  }
  return { key: '', base: '', model: '' };
}

// 看图走同一套 Kimi key。k3 本身能看图；moonshot-v1-vision 将于 2026-08-31 下线。
function visionConfig() {
  const llm = llmConfig();
  const model = process.env.LIB_VISION_MODEL || llm.model || 'k3';
  return { key: llm.key, base: llm.base, model };
}

module.exports = { isKimiK3, parseLlmJson, llmConfig, visionConfig };
