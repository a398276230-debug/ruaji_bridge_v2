/**
 * src/tools/bridge-tools.js —— Bridge 层的本地自有能力工具执行器。
 *
 * 职责：
 * 承接桥接自身维护的本地业务能力（如表情包检索、本地状态、好感度查询等），
 * 区别于 OneBot 协议端原生工具与 Python 统一宿主工具，保持模块边界清晰。
 *
 * 数据来源只有面板 HTTP 一条路，不做本地文件降级 —— Bridge 不在线时消息本就
 * 到不了 Hermes，为一个不存在的场景兜底只会让"查不到"和"查坏了"混成一件事。
 * 面板的 /api/memes/search 直接复用主链路的 MemeStore.search()，因此候选天然
 * 与真实能发出去的表情一致（已过滤越界路径与丢失文件）。
 */

export const BRIDGE_TOOLS_MANIFEST = [
  {
    name: 'search_memes',
    description: 'Search the local Sideria Bridge meme library by emotion, situation, tag, category, or keyword. Use this when a meme would genuinely improve a QQ reply. The result contains stable ids; select at most one by following the returned marker instructions. Do not use a meme in every reply.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Desired emotion, situation, tag, or keyword.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum candidates to return (1-10).',
          default: 5,
          minimum: 1,
          maximum: 10,
        },
      },
      required: ['query'],
    },
  },
];

const MEME_USAGE =
  'To send one result, put &&meme:ID&& on its own line at the end of your final response, replacing ID with the chosen result id. Use at most one and omit the marker when no result fits naturally.';

export class BridgeToolsExecutor {
  constructor(opts = {}) {
    this.memeBaseUrl = String(
      opts.memeBaseUrl || process.env.RUAJI_V2_WEB_BASE_URL || 'http://127.0.0.1:29998',
    ).replace(/\/$/, '');
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 3000;
  }

  isSupported(name) {
    return BRIDGE_TOOLS_MANIFEST.some((t) => t.name === name);
  }

  getManifest() {
    return BRIDGE_TOOLS_MANIFEST;
  }

  async execute(name, args = {}) {
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    try {
      switch (name) {
        case 'search_memes': {
          const query = String(args.query ?? '').trim();
          const limit = Math.min(10, Math.max(1, Math.trunc(Number(args.limit)) || 5));
          const url = `${this.memeBaseUrl}/api/memes/search?q=${encodeURIComponent(query)}&limit=${limit}`;

          let res;
          try {
            res = await fetch(url, {
              headers: { Accept: 'application/json' },
              signal: AbortSignal.timeout(this.timeoutMs),
            });
          } catch (err) {
            // 面板不可达必须如实报错：静默返回空列表会被模型读成"库里没有合适的
            // 表情"，于是按 prompt 规则合法地不发图，故障就此石沉大海。
            return {
              ok: false,
              error: 'meme_service_unreachable',
              message: `无法连接 Bridge 面板 (${this.memeBaseUrl}): ${err.message}`,
              elapsedMs: elapsed(),
            };
          }

          if (!res.ok) {
            return {
              ok: false,
              error: 'meme_service_error',
              message: `Bridge 面板返回 HTTP ${res.status}`,
              elapsedMs: elapsed(),
            };
          }

          let payload;
          try {
            payload = await res.json();
          } catch (err) {
            return {
              ok: false,
              error: 'invalid_response',
              message: `Bridge 面板返回的不是合法 JSON: ${err.message}`,
              elapsedMs: elapsed(),
            };
          }

          if (!Array.isArray(payload?.results)) {
            return {
              ok: false,
              error: 'invalid_response',
              message: 'Bridge 面板响应缺少 results 数组',
              elapsedMs: elapsed(),
            };
          }

          return {
            ok: true,
            query,
            results: payload.results.slice(0, limit),
            usage: MEME_USAGE,
            elapsedMs: elapsed(),
          };
        }

        default:
          return {
            ok: false,
            error: 'unsupported_tool',
            message: `Bridge 工具 ${name} 未实现`,
            elapsedMs: elapsed(),
          };
      }
    } catch (err) {
      return {
        ok: false,
        error: 'internal_error',
        message: `${err.name}: ${err.message}`,
        elapsedMs: elapsed(),
      };
    }
  }
}
