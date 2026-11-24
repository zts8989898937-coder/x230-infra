const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCodexRollout } = require('./codex-rollout');

function jsonl(records) {
  return records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
}

test('parses session_meta, turn_context, and modern user/assistant turns', () => {
  const input = jsonl([
    {
      timestamp: '2026-11-16T01:00:00Z',
      type: 'session_meta',
      payload: { id: 'thread-abc-123', cwd: '/home/zts/project' },
    },
    {
      timestamp: '2026-11-16T01:00:01Z',
      type: 'turn_context',
      payload: { turn_id: 't1', model: 'gpt-5.4', effort: 'medium', cwd: '/home/zts/project' },
    },
    {
      type: 'response_item',
      payload: {
        id: 'msg-u1',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '第一行问题\n第二行细节' }],
        metadata: {
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ['user.text'],
          },
        },
      },
    },
    {
      type: 'response_item',
      payload: {
        id: 'msg-a1',
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: '先检查一下。' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        id: 'msg-a2',
        type: 'message',
        role: 'assistant',
        phase: 'final',
        content: [{ type: 'output_text', text: '已完成。\n结果正常。' }],
      },
    },
  ]);

  const res = parseCodexRollout(input);
  assert.equal(res.threadId, 'thread-abc-123');
  assert.equal(res.cwd, '/home/zts/project');
  assert.equal(res.model, 'gpt-5.4');
  assert.equal(res.effort, 'medium');
  assert.equal(res.turns.length, 1);
  assert.deepEqual(res.turns[0], {
    id: 'msg-u1',
    index: 1,
    summary: '第一行问题',
    prompt: '第一行问题\n第二行细节',
    promptAnsi: '第一行问题\n第二行细节',
    reply: '先检查一下。\n\n已完成。\n结果正常。',
    replyAnsi: '先检查一下。\n\n已完成。\n结果正常。',
    lineCount: 4,
  });
});

test('excludes reasoning, tool_call, tool_output, developer and system messages', () => {
  const input = jsonl([
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'developer secret' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: 'system prompt' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        id: 'u-1',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '查看状态' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'internal reasoning' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell',
        arguments: '{"cmd":"ls"}',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        output: 'file1.js\nfile2.js',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'tool_call',
        name: 'read_file',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'tool_output',
        output: 'tool output text',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'analysis',
        content: [{ type: 'output_text', text: 'hidden phase text' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final',
        content: [{ type: 'output_text', text: '状态正常' }],
      },
    },
  ]);

  const res = parseCodexRollout(input);
  assert.equal(res.turns.length, 1);
  assert.equal(res.turns[0].prompt, '查看状态');
  assert.equal(res.turns[0].reply, '状态正常');
  assert.doesNotMatch(res.turns[0].reply, /reasoning|ls|file1|tool output|hidden phase/);
});

test('filters context items via internal_chat_message_metadata_passthrough and fallback prefixes', () => {
  const input = jsonl([
    {
      type: 'response_item',
      payload: {
        id: 'ctx-only-meta',
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '# AGENTS.md instructions for repo' },
          { type: 'input_text', text: '<environment_context><cwd>/tmp</cwd></environment_context>' },
        ],
        metadata: {
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ['agents_md.instructions', 'environments.environment_context'],
          },
        },
      },
    },
    {
      type: 'response_item',
      payload: {
        id: 'mixed-meta',
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '# AGENTS.md instructions...' },
          { type: 'input_text', text: '<environment_context>...</environment_context>' },
          { type: 'input_text', text: '真正的用户提问' },
        ],
        metadata: {
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: [
              'agents_md.instructions',
              'environments.environment_context',
              'user.text',
            ],
          },
        },
      },
    },
    {
      type: 'response_item',
      payload: {
        id: 'no-meta',
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '  # AGENTS.md instructions\n...' },
          { type: 'input_text', text: '<environment_context>\n  <shell>fish</shell>\n</environment_context>' },
          { type: 'input_text', text: '无元数据时的提问' },
        ],
      },
    },
  ]);

  const res = parseCodexRollout(input);
  assert.equal(res.turns.length, 2);
  assert.equal(res.turns[0].id, 'mixed-meta');
  assert.equal(res.turns[0].prompt, '真正的用户提问');
  assert.equal(res.turns[1].id, 'no-meta');
  assert.equal(res.turns[1].prompt, '无元数据时的提问');
});

test('preserves user image/file text labels and shows [图片] when only input_image is present', () => {
  const input = jsonl([
    {
      type: 'response_item',
      payload: {
        id: 'img-only',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAA' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        id: 'img-with-label',
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '[image: screenshot.png]' },
          { type: 'input_image', image_url: 'data:image/png;base64,BBB' },
          { type: 'input_text', text: '[file: notes.md]' },
        ],
      },
    },
  ]);

  const res = parseCodexRollout(input);
  assert.equal(res.turns.length, 2);
  assert.equal(res.turns[0].prompt, '[图片]');
  assert.equal(res.turns[1].prompt, '[image: screenshot.png]\n[file: notes.md]');
});

test('treats each user steering message in the same turn_id as a separate turn with fallback stable id', () => {
  const input = jsonl([
    {
      type: 'turn_context',
      payload: { turn_id: 'same-turn', model: 'gpt-5.4' },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '第一条指令' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: '收到第一条' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '补充 steering 指令' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final',
        content: [{ type: 'output_text', text: '按补充完成' }],
      },
    },
  ]);

  const res = parseCodexRollout(input);
  assert.equal(res.turns.length, 2);
  assert.equal(res.turns[0].index, 1);
  assert.equal(res.turns[0].prompt, '第一条指令');
  assert.equal(res.turns[0].reply, '收到第一条');
  assert.equal(res.turns[1].index, 2);
  assert.equal(res.turns[1].prompt, '补充 steering 指令');
  assert.equal(res.turns[1].reply, '按补充完成');
  assert.ok(res.turns[0].id);
  assert.ok(res.turns[1].id);
  assert.notEqual(res.turns[0].id, res.turns[1].id);
});

test('ignores compacted.replacement_history so old history is not replayed', () => {
  const input = jsonl([
    {
      type: 'compacted',
      payload: {
        message: 'Compacted',
        replacement_history: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '旧会话第一轮' }],
          },
          {
            type: 'message',
            role: 'assistant',
            phase: 'final',
            content: [{ type: 'output_text', text: '旧会话回复' }],
          },
        ],
      },
    },
    {
      type: 'response_item',
      payload: {
        id: 'after-compact',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '压缩后的新提问' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final',
        content: [{ type: 'output_text', text: '新回复' }],
      },
    },
  ]);

  const res = parseCodexRollout(input);
  assert.equal(res.turns.length, 1);
  assert.equal(res.turns[0].id, 'after-compact');
  assert.equal(res.turns[0].prompt, '压缩后的新提问');
  assert.equal(res.turns[0].reply, '新回复');
});

test('deduplicates event_msg item_completed and prefers modern response_item over legacy event_msg', () => {
  const mixedInput = jsonl([
    {
      type: 'response_item',
      payload: {
        id: 'u-mod',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '现代用户消息' }],
      },
    },
    {
      type: 'event_msg',
      payload: { type: 'user_message', message: '现代用户消息' },
    },
    {
      type: 'response_item',
      payload: {
        id: 'a-mod',
        type: 'message',
        role: 'assistant',
        phase: 'final',
        content: [{ type: 'output_text', text: '现代助手回复' }],
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'agent_message', text: '现代助手回复' },
      },
    },
    {
      type: 'event_msg',
      payload: { type: 'agent_message', message: '现代助手回复' },
    },
  ]);

  const modernRes = parseCodexRollout(mixedInput);
  assert.equal(modernRes.turns.length, 1);
  assert.equal(modernRes.turns[0].prompt, '现代用户消息');
  assert.equal(modernRes.turns[0].reply, '现代助手回复');

  const legacyOnlyInput = jsonl([
    {
      type: 'session_meta',
      payload: { id: 'legacy-1', cwd: '/tmp/legacy' },
    },
    {
      type: 'event_msg',
      payload: { type: 'user_message', message: '旧版问题' },
    },
    {
      type: 'event_msg',
      payload: { type: 'agent_message', message: '旧版回答' },
    },
  ]);

  const legacyRes = parseCodexRollout(legacyOnlyInput);
  assert.equal(legacyRes.threadId, 'legacy-1');
  assert.equal(legacyRes.cwd, '/tmp/legacy');
  assert.equal(legacyRes.turns.length, 1);
  assert.equal(legacyRes.turns[0].prompt, '旧版问题');
  assert.equal(legacyRes.turns[0].reply, '旧版回答');
});

test('ignores incomplete JSON lines while continuing to parse subsequent valid lines', () => {
  const input = [
    JSON.stringify({
      type: 'response_item',
      payload: {
        id: 'u-1',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '第一问' }],
      },
    }),
    '{"type":"response_item","payload":{"type":"message","role":"assistant"',
    JSON.stringify({
      type: 'response_item',
      payload: {
        id: 'a-1',
        type: 'message',
        role: 'assistant',
        phase: 'final',
        content: [{ type: 'output_text', text: '有效后续回复' }],
      },
    }),
    '{"type":"response_item","broken_tail":',
  ].join('\n');

  const res = parseCodexRollout(input);
  assert.equal(res.turns.length, 1);
  assert.equal(res.turns[0].prompt, '第一问');
  assert.equal(res.turns[0].reply, '有效后续回复');
});

test('legacy private phases and injected context are excluded from visible history', () => {
  const event = (type, message, phase) => ({ type: 'event_msg', payload: { type, message, phase } });
  const result = parseCodexRollout(jsonl([
    event('user_message', '<environment_context>private setup</environment_context>'),
    event('user_message', 'visible question'),
    event('agent_message', 'private analysis', 'analysis'),
    event('agent_message', 'visible answer', 'final_answer')
  ]));
  assert.deepEqual(result.turns.map(({ prompt, reply }) => [prompt, reply]), [['visible question', 'visible answer']]);
});
