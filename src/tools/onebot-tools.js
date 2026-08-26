/**
 * src/tools/onebot-tools.js —— Bridge 层的 OneBot (NapCat/LLBot) 原生工具执行器。
 * 
 * 职责：
 * 承接 Hermes Agent / MCP 调用的 21 个 QQ 基础工具（群文件、历史消息、戳一戳、语音转换等），
 * 直连 NapCat HTTP API 执行，彻底消除 Python 统一宿主的反向代理耦合。
 * 
 * 契约保证：
 * 工具名、输入参数 Schema、返回值 JSON 结构与原 Python 宿主 100% 严格一致。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

export const ONEBOT_TOOLS_MANIFEST = [
  {
    name: 'list_group_files',
    description: '查看 QQ 群文件列表（根目录或指定子文件夹）。返回群文件的文件名、大小、上传者、上传时间及 file_id。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '目标 QQ 群号。' },
        folder_id: { type: 'string', description: '可选。子文件夹 ID。不传则查询根目录。', default: '' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'download_group_file',
    description: '下载指定的 QQ 群文件到本地 received_files 目录，并返回绝对路径供读取和分析。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'QQ 群号。' },
        file_id: { type: 'string', description: '群文件 ID（从 list_group_files 获取）。' },
        busid: { type: 'integer', description: '文件 busid，默认 102。', default: 102 },
        file_name: { type: 'string', description: '可选。期望保存的文件名。', default: '' },
      },
      required: ['group_id', 'file_id'],
    },
  },
  {
    name: 'upload_group_file',
    description: '将本地文件上传到指定 QQ 群的群文件中。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '目标 QQ 群号。' },
        file_path: { type: 'string', description: '本地文件的绝对路径。' },
        name: { type: 'string', description: '可选。上传后在群文件中显示的文件名（默认取本地文件名）。', default: '' },
        folder_id: { type: 'string', description: '可选。目标群文件夹 ID（不填则传到根目录）。', default: '' },
      },
      required: ['group_id', 'file_path'],
    },
  },
  {
    name: 'download_url_file',
    description: '通过底层协议端或直接下载网络直链文件 / 闪传文件到本地 received_files 缓存。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '可选。文件的网络直链 URL。', default: '' },
        name: { type: 'string', description: '可选。保存的文件名。', default: '' },
        share_link: { type: 'string', description: '可选。闪传文件链接（share_link）。', default: '' },
      },
    },
  },
  {
    name: 'fetch_chat_history',
    description: '翻查指定 QQ 群聊或私聊的真实历史消息记录。用于还原此前对话上下文、查找某人刚才说了什么。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '可选。群号（查群聊历史时必填）。', default: '' },
        user_id: { type: 'string', description: '可选。用户 QQ 号（查私聊历史时必填）。', default: '' },
        count: { type: 'integer', description: '拉取的历史消息条数，默认 20，最大 50。', default: 20 },
      },
    },
  },
  {
    name: 'get_forward_messages',
    description: '解包并读取合并转发消息（聊天记录包）的具体内容。需要提供消息 ID (message_id)。',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: '合并转发消息的 message_id。' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'voice_to_text',
    description: '使用 QQ 官方原生接口将指定的语音消息转换为文字。需要提供语音消息的 message_id。',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: '语音消息的 message_id。' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'send_poke',
    description: '在群内或私聊中向指定用户发送戳一戳（双击头像互动）。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '可选。群聊中戳人时填群号。', default: '' },
        user_id: { type: 'string', description: '目标用户的 QQ 号。' },
      },
      required: ['user_id'],
    },
  },
  {
    name: 'get_group_file_system_info',
    description: '查询指定 QQ 群的文件系统容量与统计信息（文件总数、空间上限、已用空间）。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '目标 QQ 群号。' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'upload_private_file',
    description: '将本地文件通过私聊发送给指定好友（如发送生成的报告、音频、代码文件）。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: '目标用户的 QQ 号。' },
        file_path: { type: 'string', description: '本地文件的绝对路径。' },
        name: { type: 'string', description: '可选。私聊窗口显示的文件名（默认取本地文件名）。', default: '' },
      },
      required: ['user_id', 'file_path'],
    },
  },
  {
    name: 'get_image_detail',
    description: '获取消息中图片的本地缓存绝对路径或高清下载直链。需要提供图片的 file 标识。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '图片的 file 标识（如 CQ 码中的 file=... 或文件名）。' },
      },
      required: ['file'],
    },
  },
  {
    name: 'download_chat_file',
    description: '让 QQ 客户端在后台静默下载消息中的文件并返回本地绝对路径。需要提供文件的 file 标识。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文件的 file 标识（如 CQ 码中的 file=... 或 file_id）。' },
      },
      required: ['file'],
    },
  },
  {
    name: 'convert_voice_to_mp3',
    description: '将消息中的语音（腾讯专有 silk 格式）在协议端自动转码为标准 MP3 并返回本地文件路径。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '语音消息的 file 标识。' },
      },
      required: ['file'],
    },
  },
  {
    name: 'list_joined_groups',
    description: '获取机器人当前加入的所有 QQ 群列表（包含群号 group_id、群名称 group_name、成员总数、群主 QQ 等）。',
    parameters: {
      type: 'object',
      properties: {
        no_cache: { type: 'boolean', description: '是否强制刷新缓存，默认 false。', default: false },
      },
    },
  },
  {
    name: 'get_group_info',
    description: '获取指定 QQ 群的详细资料（群名称、公告 memo、创建时间、成员数与上限、群主等）。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '目标 QQ 群号。' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'list_group_members',
    description: '获取指定 QQ 群的完整群成员列表（每个群员的 QQ、昵称、群名片 card、角色 role（owner/admin/member）、专属头衔 title 等）。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '目标 QQ 群号。' },
        no_cache: { type: 'boolean', description: '是否强制刷新缓存，默认 false。', default: false },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'get_group_member_info',
    description: '获取指定 QQ 群里某个具体群成员的详细资料（群名片、角色身份、头衔、禁言状态等）。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '目标 QQ 群号。' },
        user_id: { type: 'string', description: '目标群成员的 QQ 号。' },
        no_cache: { type: 'boolean', description: '是否强制刷新缓存，默认 false。', default: false },
      },
      required: ['group_id', 'user_id'],
    },
  },
  {
    name: 'get_message_detail',
    description: '精确查询单条消息的原始详情（发送者昵称、真实卡片、原始图片直链、CQ码与时间戳）。需要提供消息 ID (message_id)。',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: '消息 ID。' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'forward_message',
    description: '以 QQ 原生消息卡片形式，将某条指定消息转发到目标群聊或私聊好友中。',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: '要转发的消息 ID。' },
        target_group_id: { type: 'string', description: '可选。转发目标群号（群聊转发时填）。', default: '' },
        target_user_id: { type: 'string', description: '可选。转发目标好友 QQ 号（私聊转发时填）。', default: '' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'get_ai_characters',
    description: '获取群 AI 语音可用的声色列表（如酥心御姐、元气少女、傲娇少女、小新、四郎等）。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '目标 QQ 群号。' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'send_group_ai_record',
    description: '在指定群聊中，以指定的 AI 声色生成语音条并直接发送到群里。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '目标 QQ 群号。' },
        character: { type: 'string', description: '声色 ID（如 lucy-voice-suxinjiejie 等，从 get_ai_characters 获取）。' },
        text: { type: 'string', description: '要转成语音发送的文本内容。' },
      },
      required: ['group_id', 'character', 'text'],
    },
  },
];

export class OneBotToolsExecutor {
  constructor(opts = {}) {
    this.httpUrl = String(opts.httpUrl || process.env.NAPCAT_HTTP_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
    this.accessToken = String(opts.accessToken || process.env.NAPCAT_ACCESS_TOKEN || '');
    this.downloadDir = resolve(opts.downloadDir || process.env.NAPCAT_DOWNLOAD_DIR || './data/received_files');
  }

  isSupported(name) {
    return ONEBOT_TOOLS_MANIFEST.some(t => t.name === name);
  }

  getManifest() {
    return ONEBOT_TOOLS_MANIFEST;
  }

  async _onebotRequest(action, { method = 'GET', query = null, body = null, timeoutMs = 60000 } = {}) {
    const url = new URL(`${this.httpUrl}/${action}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const headers = { 'Content-Type': 'application/json' };
    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }

    const init = {
      method: method.toUpperCase(),
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body) {
      init.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      return {
        ok: false,
        error: 'onebot_unreachable',
        message: `连不上 OneBot (${this.httpUrl}): ${err.message}`,
      };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        error: 'http_error',
        status: res.status,
        message: `OneBot HTTP ${res.status}: ${text.slice(0, 300)}`,
      };
    }

    try {
      const data = await res.json();
      return data && typeof data === 'object' ? data : { ok: true, data };
    } catch {
      const text = await res.text().catch(() => '');
      return { ok: true, text };
    }
  }

  _isSucceeded(res) {
    if (!res || typeof res !== 'object') return false;
    if (res.ok === false) return false;
    if ('retcode' in res) {
      return Number(res.retcode) === 0;
    }
    if ('status' in res) {
      return String(res.status).toLowerCase() === 'ok';
    }
    return true;
  }

  _formatFailure(res, defaultError = 'onebot_failed') {
    const out = { ok: false, error: res?.error || defaultError };
    if (res && typeof res === 'object') {
      for (const k of ['status', 'retcode', 'message', 'wording', 'msg']) {
        if (res[k] !== undefined && res[k] !== null) out[k] = res[k];
      }
      out.raw = res;
    }
    return out;
  }

  _asQq(val) {
    const s = String(val ?? '').trim();
    return /^\d+$/.test(s) ? Number(s) : val;
  }

  async execute(name, args = {}) {
    const started = Date.now();
    try {
      let result;
      switch (name) {
        case 'list_group_files': {
          const gid = String(args.group_id || '').trim();
          if (!gid) return { ok: false, error: 'missing_group_id', message: '必须提供群号 group_id' };
          const fid = String(args.folder_id || '').trim();
          const action = fid ? 'get_group_files_by_folder' : 'get_group_root_files';
          const query = { group_id: gid };
          if (fid) query.folder_id = fid;
          const res = await this._onebotRequest(action, { query });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          const data = res.data || {};
          result = {
            ok: true,
            groupId: gid,
            folderId: fid || 'root',
            files: data.files || [],
            folders: data.folders || [],
          };
          break;
        }

        case 'download_group_file': {
          const gid = String(args.group_id || '').trim();
          const fid = String(args.file_id || '').trim();
          const busid = Number(args.busid) || 102;
          const fileName = String(args.file_name || '').trim();
          if (!gid || !fid) return { ok: false, error: 'missing_params', message: '必须提供 group_id 和 file_id' };
          const urlRes = await this._onebotRequest('get_group_file_url', {
            query: { group_id: gid, file_id: fid, busid },
          });
          if (!this._isSucceeded(urlRes)) return this._formatFailure(urlRes, 'get_url_failed');
          const fileUrl = urlRes.data?.url;
          if (!fileUrl) return { ok: false, error: 'get_url_failed', message: '协议端没给出文件链接', raw: urlRes };

          const cleanPath = String(fileUrl).replace(/^file:\/\/\/?/, '');
          if (existsSync(cleanPath)) {
            result = { ok: true, localPath: resolve(cleanPath), url: fileUrl, cached: true };
            break;
          }

          if (!existsSync(this.downloadDir)) mkdirSync(this.downloadDir, { recursive: true });
          const fname = fileName || `group_file_${Date.now()}_${basename(fid)}`;
          const targetPath = resolve(this.downloadDir, basename(fname));

          const dlRes = await fetch(fileUrl, { signal: AbortSignal.timeout(120000) });
          if (!dlRes.ok) return { ok: false, error: 'download_failed', status: dlRes.status };
          const buffer = Buffer.from(await dlRes.arrayBuffer());
          writeFileSync(targetPath, buffer);
          result = { ok: true, localPath: targetPath, sizeBytes: buffer.length, url: fileUrl };
          break;
        }

        case 'upload_group_file': {
          const gid = String(args.group_id || '').trim();
          const fpath = String(args.file_path || '').trim();
          if (!gid || !fpath) return { ok: false, error: 'missing_params', message: '必须提供 group_id 和 file_path' };
          const absPath = resolve(fpath);
          if (!existsSync(absPath)) return { ok: false, error: 'file_not_found', message: `本地文件不存在: ${absPath}` };
          const uploadName = String(args.name || '').trim() || basename(absPath);
          const body = { group_id: this._asQq(gid), file: absPath.replace(/\\/g, '/'), name: uploadName };
          if (args.folder_id) body.folder = String(args.folder_id).trim();
          const res = await this._onebotRequest('upload_group_file', { method: 'POST', body, timeoutMs: 120000 });
          if (!this._isSucceeded(res)) return this._formatFailure(res, 'upload_failed');
          result = { ok: true, groupId: gid, fileName: uploadName, data: res.data };
          break;
        }

        case 'download_url_file': {
          const { url, name: fname, share_link } = args;
          if (share_link) {
            const res = await this._onebotRequest('download_flash_file', { method: 'POST', body: { share_link } });
            if (!this._isSucceeded(res)) return this._formatFailure(res);
            result = { ok: true, type: 'flash_file', data: res.data ?? res };
            break;
          }
          if (url) {
            const res = await this._onebotRequest('download_file', {
              method: 'POST',
              body: { url, name: fname || 'downloaded_file' },
            });
            if (!this._isSucceeded(res)) return this._formatFailure(res);
            result = { ok: true, type: 'direct_url', data: res.data ?? res };
            break;
          }
          return { ok: false, error: 'missing_url_or_link', message: '必须提供 url 或 share_link' };
        }

        case 'fetch_chat_history': {
          const gid = String(args.group_id || '').trim();
          const uid = String(args.user_id || '').trim();
          const count = Math.max(1, Math.min(Number(args.count) || 20, 50));
          let action, query, kind, key, ident;
          if (gid) {
            action = 'get_group_msg_history';
            query = { group_id: gid, count };
            kind = 'group';
            key = 'groupId';
            ident = gid;
          } else if (uid) {
            action = 'get_friend_msg_history';
            query = { user_id: uid, count };
            kind = 'private';
            key = 'userId';
            ident = uid;
          } else {
            return { ok: false, error: 'missing_target', message: '必须提供 group_id 或 user_id' };
          }
          const res = await this._onebotRequest(action, { query });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          let msgs = res.data?.messages ?? res.data;
          msgs = Array.isArray(msgs) ? msgs : [];
          result = { ok: true, type: kind, [key]: ident, count: msgs.length, messages: msgs };
          break;
        }

        case 'get_forward_messages': {
          const mid = String(args.message_id || '').trim();
          if (!mid) return { ok: false, error: 'missing_message_id', message: '必须提供 message_id' };
          const res = await this._onebotRequest('get_forward_msg', { query: { message_id: mid } });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          let msgs = res.data?.messages ?? res.data;
          result = { ok: true, messageId: mid, messages: Array.isArray(msgs) ? msgs : [] };
          break;
        }

        case 'voice_to_text': {
          const mid = String(args.message_id || '').trim();
          if (!mid) return { ok: false, error: 'missing_message_id', message: '必须提供 message_id' };
          const res = await this._onebotRequest('voice_msg_to_text', { query: { message_id: mid } });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          const text = res.data?.text ?? res.text;
          if (!text) return { ok: false, error: 'empty_transcript', message: '协议端没给出转写文本', raw: res };
          result = { ok: true, messageId: mid, text: String(text) };
          break;
        }

        case 'send_poke': {
          const uid = String(args.user_id || '').trim();
          const gid = String(args.group_id || '').trim();
          if (!uid) return { ok: false, error: 'missing_user_id', message: '必须提供 user_id' };
          const body = { user_id: this._asQq(uid), target_id: this._asQq(uid) };
          if (gid) body.group_id = this._asQq(gid);
          const res = await this._onebotRequest('send_poke', { method: 'POST', body });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          result = { ok: true, targetId: uid, groupId: gid || null };
          break;
        }

        case 'get_group_file_system_info': {
          const gid = String(args.group_id || '').trim();
          if (!gid) return { ok: false, error: 'missing_group_id', message: '必须提供 group_id' };
          const res = await this._onebotRequest('get_group_file_system_info', { query: { group_id: gid } });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          result = { ok: true, groupId: gid, data: res.data };
          break;
        }

        case 'upload_private_file': {
          const uid = String(args.user_id || '').trim();
          const fpath = String(args.file_path || '').trim();
          if (!uid || !fpath) return { ok: false, error: 'missing_params', message: '必须提供 user_id 和 file_path' };
          const absPath = resolve(fpath);
          if (!existsSync(absPath)) return { ok: false, error: 'file_not_found', message: `本地文件不存在: ${absPath}` };
          const uploadName = String(args.name || '').trim() || basename(absPath);
          const body = { user_id: this._asQq(uid), file: absPath.replace(/\\/g, '/'), name: uploadName };
          const res = await this._onebotRequest('upload_private_file', { method: 'POST', body, timeoutMs: 120000 });
          if (!this._isSucceeded(res)) return this._formatFailure(res, 'upload_failed');
          result = { ok: true, userId: uid, fileName: uploadName, data: res.data };
          break;
        }

        case 'get_image_detail': {
          const f = String(args.file || '').trim();
          if (!f) return { ok: false, error: 'missing_file', message: '必须提供图片的 file 标识' };
          const res = await this._onebotRequest('get_image', { query: { file: f } });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          const data = res.data || {};
          result = {
            ok: true,
            file: f,
            localPath: data.file,
            url: data.url,
            fileSize: data.file_size,
            fileName: data.file_name,
          };
          break;
        }

        case 'download_chat_file': {
          const f = String(args.file || '').trim();
          if (!f) return { ok: false, error: 'missing_file', message: '必须提供文件的 file 标识' };
          const res = await this._onebotRequest('get_file', { method: 'POST', body: { file: f, download: true } });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          const data = res.data || {};
          result = {
            ok: true,
            file: f,
            localPath: data.file,
            url: data.url,
            fileSize: data.file_size,
            fileName: data.file_name,
          };
          break;
        }

        case 'convert_voice_to_mp3': {
          const f = String(args.file || '').trim();
          if (!f) return { ok: false, error: 'missing_file', message: '必须提供语音的 file 标识' };
          const res = await this._onebotRequest('get_record', { method: 'POST', body: { file: f, out_format: 'mp3' } });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          const data = res.data || {};
          result = {
            ok: true,
            file: f,
            localPath: data.file,
            fileSize: data.file_size,
            fileName: data.file_name,
            base64: Boolean(data.base64),
          };
          break;
        }

        case 'list_joined_groups': {
          const res = await this._onebotRequest('get_group_list', { query: { no_cache: Boolean(args.no_cache) } });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          const groups = Array.isArray(res.data) ? res.data : [];
          result = { ok: true, count: groups.length, groups };
          break;
        }

        case 'get_group_info': {
          const gid = String(args.group_id || '').trim();
          if (!gid) return { ok: false, error: 'missing_group_id', message: '必须提供 group_id' };
          const res = await this._onebotRequest('get_group_info', { query: { group_id: gid } });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          result = { ok: true, groupId: gid, data: res.data };
          break;
        }

        case 'list_group_members': {
          const gid = String(args.group_id || '').trim();
          if (!gid) return { ok: false, error: 'missing_group_id', message: '必须提供 group_id' };
          const res = await this._onebotRequest('get_group_member_list', {
            query: { group_id: gid, no_cache: Boolean(args.no_cache) },
          });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          const members = Array.isArray(res.data) ? res.data : [];
          result = { ok: true, groupId: gid, count: members.length, members };
          break;
        }

        case 'get_group_member_info': {
          const gid = String(args.group_id || '').trim();
          const uid = String(args.user_id || '').trim();
          if (!gid || !uid) return { ok: false, error: 'missing_params', message: '必须提供 group_id 和 user_id' };
          const res = await this._onebotRequest('get_group_member_info', {
            query: { group_id: gid, user_id: uid, no_cache: Boolean(args.no_cache) },
          });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          result = { ok: true, groupId: gid, userId: uid, data: res.data };
          break;
        }

        case 'get_message_detail': {
          const mid = String(args.message_id || '').trim();
          if (!mid) return { ok: false, error: 'missing_message_id', message: '必须提供 message_id' };
          const res = await this._onebotRequest('get_msg', { query: { message_id: mid } });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          result = { ok: true, messageId: mid, data: res.data };
          break;
        }

        case 'forward_message': {
          const mid = String(args.message_id || '').trim();
          const gid = String(args.target_group_id || '').trim();
          const uid = String(args.target_user_id || '').trim();
          if (!mid) return { ok: false, error: 'missing_message_id', message: '必须提供 message_id' };
          let action, body, tail;
          if (gid) {
            action = 'forward_group_single_msg';
            body = { group_id: this._asQq(gid), message_id: this._asQq(mid) };
            tail = { type: 'group', targetGroupId: gid };
          } else if (uid) {
            action = 'forward_friend_single_msg';
            body = { user_id: this._asQq(uid), message_id: this._asQq(mid) };
            tail = { type: 'private', targetUserId: uid };
          } else {
            return { ok: false, error: 'missing_target', message: '必须提供 target_group_id 或 target_user_id' };
          }
          const res = await this._onebotRequest(action, { method: 'POST', body });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          result = { ok: true, messageId: mid, data: res.data, ...tail };
          break;
        }

        case 'get_ai_characters': {
          const gid = String(args.group_id || '').trim();
          if (!gid) return { ok: false, error: 'missing_group_id', message: '必须提供 group_id' };
          const res = await this._onebotRequest('get_ai_characters', { query: { group_id: gid, chat_type: 1 } });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          result = { ok: true, groupId: gid, characters: res.data };
          break;
        }

        case 'send_group_ai_record': {
          const gid = String(args.group_id || '').trim();
          const char = String(args.character || '').trim();
          const txt = String(args.text || '').trim();
          if (!gid || !char || !txt) {
            return { ok: false, error: 'missing_params', message: '必须提供 group_id, character 和 text' };
          }
          const res = await this._onebotRequest('send_group_ai_record', {
            method: 'POST',
            body: { group_id: this._asQq(gid), character: char, text: txt },
          });
          if (!this._isSucceeded(res)) return this._formatFailure(res);
          result = { ok: true, groupId: gid, character: char, data: res.data };
          break;
        }

        default:
          return { ok: false, error: 'unsupported_tool', message: `OneBot 工具 ${name} 未实现` };
      }

      result.elapsedMs = Date.now() - started;
      return result;
    } catch (err) {
      return {
        ok: false,
        error: 'internal_error',
        message: `${err.name}: ${err.message}`,
        elapsedMs: Date.now() - started,
      };
    }
  }
}
