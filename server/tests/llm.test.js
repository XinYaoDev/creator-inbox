'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { llmConfig, usesReasoningEffort } = require('../llm.js');

test('llmConfig: OpenAI 默认使用 gpt-6-astra', () => {
  const names = [
    'NOTE_LLM_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY', 'NOTE_LLM_BASE_URL', 'NOTE_LLM_MODEL',
  ];
  const keep = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.OPENAI_API_KEY = 'openai-test';
    const config = llmConfig();
    assert.equal(config.base, 'https://api.openai.com/v1');
    assert.equal(config.model, 'gpt-6-astra');
  } finally {
    for (const [name, value] of Object.entries(keep)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('usesReasoningEffort: GPT-6 使用推理参数', () => {
  assert.equal(usesReasoningEffort('gpt-6-astra'), true);
  assert.equal(usesReasoningEffort('gpt-6.1-sol'), true);
  assert.equal(usesReasoningEffort('gpt-4o-mini'), false);
});
