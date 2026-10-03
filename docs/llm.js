// Drafting. Five providers, three wire formats.
//
// The call goes straight from your browser to the provider. That means the key
// lives on this device — a real cost, and smaller than it sounds: the worst a
// stolen LLM key does is run up a bill, where a stolen Instagram token posts as
// you. Use a spend-capped key.
//
// Every host here is also listed in index.html's connect-src. Adding a provider
// means adding it in both places, or the browser blocks the request.

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    models: ['claude-opus-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'],
    host: 'https://api.anthropic.com',
  },
  openai: {
    label: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'o4-mini'],
    host: 'https://api.openai.com',
  },
  gemini: {
    label: 'Google Gemini',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    host: 'https://generativelanguage.googleapis.com',
  },
  grok: {
    label: 'xAI (Grok)',
    models: ['grok-4', 'grok-3'],
    host: 'https://api.x.ai',
  },
  deepseek: {
    label: 'DeepSeek',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    host: 'https://api.deepseek.com',
  },
};

export class LLMError extends Error {}

const SYSTEM = `You write Instagram posts for a software testing audience.

Return ONLY a JSON object, no markdown fence, with exactly these keys:
  "headline" - 3 to 8 words. Goes large on the card image. No full stop.
  "body"     - 2 to 4 very short statements, one per line, separated by \\n.
               Each must fit on one line of a card: aim under 40 characters.
               Use "" if the headline says enough on its own.
  "caption"  - the Instagram caption. Plain text, blank lines between
               paragraphs, ending with 3 to 6 relevant hashtags. Under 2200
               characters. End with a question that invites a real reply.

No emoji in the headline or body. At most one in the caption.`;

function buildPrompt(topic, voice) {
  return `${voice ? `Brand voice:\n${voice}\n\n` : ''}Write one post about:\n${topic}`;
}

/** Pull the JSON object out of a reply, tolerating a markdown fence. */
export function parseDraft(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new LLMError('The model did not return JSON. Try again, or a different model.');
  }
  let draft;
  try {
    draft = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new LLMError('The model returned malformed JSON. Try again.');
  }
  if (!draft.headline || !draft.caption) {
    throw new LLMError('The model left out the headline or the caption. Try again.');
  }
  return {
    headline: String(draft.headline).trim(),
    body: String(draft.body || '').trim(),
    caption: String(draft.caption).trim(),
  };
}

async function post(url, headers, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // A blocked request looks identical to a dead network from here, and the
    // likeliest cause by far is a provider missing from connect-src.
    throw new LLMError('Could not reach the provider. Check the key, and that '
      + 'this provider is allowed by the page policy.');
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j.error && (j.error.message || j.error)) || j.message || '';
    } catch { /* no body */ }
    if (res.status === 401 || res.status === 403) {
      throw new LLMError(`The provider rejected the key. ${detail}`.trim());
    }
    if (res.status === 429) {
      throw new LLMError('Rate limited or out of credit at the provider.');
    }
    throw new LLMError(detail || `Provider returned ${res.status}.`);
  }
  return res.json();
}

async function callAnthropic(cfg, prompt) {
  const data = await post(`${PROVIDERS.anthropic.host}/v1/messages`, {
    'x-api-key': cfg.llmKey,
    'anthropic-version': '2023-06-01',
    // Anthropic blocks browser origins unless this opt-in is present.
    'anthropic-dangerous-direct-browser-access': 'true',
  }, {
    model: cfg.llmModel, max_tokens: 1500, system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  return (data.content || []).map((c) => c.text || '').join('');
}

async function callGemini(cfg, prompt) {
  const url = `${PROVIDERS.gemini.host}/v1beta/models/${cfg.llmModel}:generateContent`;
  // Key as a header, never a query parameter — a URL ends up in logs.
  const data = await post(url, { 'x-goog-api-key': cfg.llmKey }, {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json' },
  });
  const cand = (data.candidates || [])[0];
  return ((cand && cand.content && cand.content.parts) || [])
    .map((p) => p.text || '').join('');
}

async function callOpenAICompatible(cfg, prompt) {
  const host = PROVIDERS[cfg.llmProvider].host;
  const data = await post(`${host}/v1/chat/completions`, {
    Authorization: `Bearer ${cfg.llmKey}`,
  }, {
    model: cfg.llmModel,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
    // Grok and DeepSeek both honour this; it removes the fence-stripping guess.
    response_format: { type: 'json_object' },
  });
  const choice = (data.choices || [])[0];
  return (choice && choice.message && choice.message.content) || '';
}

export async function draft(cfg, topic, voice) {
  if (!cfg.llmKey) throw new LLMError('Add an LLM API key in Settings first.');
  if (!topic.trim()) throw new LLMError('Say what the post should be about.');

  const prompt = buildPrompt(topic.trim(), voice);
  const text = cfg.llmProvider === 'anthropic' ? await callAnthropic(cfg, prompt)
    : cfg.llmProvider === 'gemini' ? await callGemini(cfg, prompt)
      : await callOpenAICompatible(cfg, prompt);
  return parseDraft(text);
}
