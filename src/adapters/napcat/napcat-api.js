/**
 * adapters/napcat/napcat-api.js — NapCat HTTP API 客户端
 *
 * 集中所有 NapCat HTTP 调用：get_login_info / get_status / get_msg / get_image /
 * get_file / get_group_file_url / send_group_msg / send_private_msg。
 *
 * 旧 Bridge 把这些 fetch 散在 bridge.js 与 preflight.js 里，鉴权头拼了六遍，
 * 超时值 8000/10000/15000/20000/30000 各不相同且无处可查。
 */

import { SendError } from '../../contracts/errors.js';

export class NapcatApi {
  /**
   * @param {object} opts
   * @param {string} opts.httpUrl
   * @param {string} [opts.accessToken]
   * @param {number} [opts.requestTimeoutMs=8000]
   * @param {number} [opts.sendTimeoutMs=30000]
   * @param {import('../../core/logger.js').Logger} [opts.logger]
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor(opts = {}) {
    this.httpUrl = String(opts.httpUrl ?? '').replace(/\/$/, '');
    this.accessToken = opts.accessToken ?? '';
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 8000;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? 30000;
    this.log = opts.logger?.child({ component: 'napcat-api' }) ?? console;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  get headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.accessToken) h.Authorization = `Bearer ${this.accessToken}`;
    return h;
  }

  async _request(action, { method = 'GET', query, body, timeoutMs } = {}) {
    const url = new URL(`${this.httpUrl}/${action}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v != null) url.searchParams.set(k, String(v));
    }

    const init = { method, headers: this.headers, signal: AbortSignal.timeout(timeoutMs ?? this.requestTimeoutMs) };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await this.fetchImpl(url, init);
    const text = await res.text();

    let data = null;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new SendError(`NapCat ${action} 返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`, {
          status: res.status,
        });
      }
    }
    if (!res.ok) {
      throw new SendError(`NapCat ${action} HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`, {
        status: res.status,
      });
    }
    this._warnOnBusinessFailure(action, data);
    return data;
  }

  /**
   * OneBot 的业务失败是「HTTP 200 + retcode != 0」，光看 res.ok 看不出来。
   * 换协议端（NapCat ⇄ LLBot）时这条尤其要紧：两边支持的 action 不是同一套，
   * 缺失的那些正是靠 retcode 报出来的 —— 不看它的话，下面各 wrapper 里的
   * `data?.data ?? null` 会把「这个动作我不支持」变成一个安静的 null / []，
   * 排查时只能看见"功能没生效"，看不见原因。
   *
   * 只 warn 不抛：wrapper 的返回值语义（null / [] / 原始信封）已经被上层依赖，
   * 改成抛异常等于换掉整层的错误契约。要判死活的调用方自己看 retcode，
   * 比如下面的 sendMessage()。
   */
  _warnOnBusinessFailure(action, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    // 扩展接口（download_file 等）不一定裹 OneBot 信封，没信封就没得判
    if (!('retcode' in data) && !('status' in data)) return;

    const status = data.status == null ? null : String(data.status).toLowerCase();
    // OneBot v11：status=async（retcode=1）是"已受理，异步执行"，不是失败
    if (status === 'ok' || status === 'async') return;
    if (status === null && Number(data.retcode ?? 0) === 0) return;

    // sendMessage() 把 "Timeout: NTEvent" 显式建模成成功（消息已发出，只是回调
    // 确认超时，见该方法注释）。这里跟着报警只会制造噪音。
    if (typeof data.message === 'string' && data.message.includes('Timeout: NTEvent')) return;

    this.log.warn?.(`NapCat ${action} 业务失败（HTTP 200 但 retcode 非 0）`, {
      action,
      status: data.status ?? null,
      retcode: data.retcode ?? null,
      message: data.message ?? data.wording ?? data.msg ?? null,
    });
  }

  async getLoginInfo() {
    return this._request('get_login_info');
  }

  async getStatus() {
    return this._request('get_status');
  }

  async getMsg(messageId) {
    const data = await this._request('get_msg', { query: { message_id: messageId } });
    return data?.data ?? null;
  }

  async getImageUrl(file) {
    const data = await this._request('get_image', { query: { file } });
    return data?.data?.url ?? null;
  }

  /** 私聊/通用文件：返回 { url, file } —— NapCat 有时直接给本地路径 */
  async getFile(fileId) {
    const data = await this._request('get_file', { query: { file_id: fileId } });
    return { url: data?.data?.url ?? null, file: data?.data?.file ?? null };
  }

  async getGroupFileUrl(groupId, fileId, busid = 102) {
    const data = await this._request('get_group_file_url', {
      query: { group_id: groupId, file_id: fileId, busid },
    });
    return data?.data?.url ?? null;
  }

  /** 获取群根目录文件列表 */
  async getGroupRootFiles(groupId) {
    const data = await this._request('get_group_root_files', {
      query: { group_id: groupId },
    });
    return data?.data ?? null;
  }

  /** 根据文件夹 ID 获取群文件列表 */
  async getGroupFilesByFolder(groupId, folderId) {
    const data = await this._request('get_group_files_by_folder', {
      query: { group_id: groupId, folder_id: folderId },
    });
    return data?.data ?? null;
  }

  /** 上传群文件（file 支持本地绝对路径 file:/// 或 http 直链） */
  async uploadGroupFile(groupId, file, name, folder = '') {
    const body = { group_id: groupId, file, name };
    if (folder) body.folder = folder;
    const data = await this._request('upload_group_file', {
      method: 'POST',
      body,
      timeoutMs: this.sendTimeoutMs,
    });
    return data?.data ?? null;
  }

  /** 上传私聊文件 */
  async uploadPrivateFile(userId, file, name) {
    const data = await this._request('upload_private_file', {
      method: 'POST',
      body: { user_id: userId, file, name },
      timeoutMs: this.sendTimeoutMs,
    });
    return data?.data ?? null;
  }

  /** 下载文件到协议端缓存目录（LLBot 扩展） */
  async downloadFile({ url, name, headers = [] }) {
    const body = { url, name, headers };
    const data = await this._request('download_file', {
      method: 'POST',
      body,
      timeoutMs: this.sendTimeoutMs,
    });
    return data?.data ?? data;
  }

  /** 下载闪传文件（LLBot 扩展） */
  async downloadFlashFile({ share_link, file_set_id }) {
    const body = {};
    if (share_link) body.share_link = share_link;
    if (file_set_id) body.file_set_id = file_set_id;
    const data = await this._request('download_flash_file', {
      method: 'POST',
      body,
      timeoutMs: this.sendTimeoutMs,
    });
    return data?.data ?? data;
  }

  /** 获取群文件系统容量信息 */
  async getGroupFileSystemInfo(groupId) {
    const data = await this._request('get_group_file_system_info', {
      query: { group_id: groupId },
    });
    return data?.data ?? null;
  }

  /** 获取私聊文件下载链接 */
  async getPrivateFileUrl(fileId) {
    const data = await this._request('get_private_file_url', {
      query: { file_id: fileId },
    });
    return data?.data?.url ?? null;
  }

  /** 获取群历史消息 */
  async getGroupMsgHistory(groupId, { count = 20, messageSeq = 0, reverseOrder = false } = {}) {
    const query = { group_id: groupId, count, message_seq: messageSeq, reverseOrder };
    const data = await this._request('get_group_msg_history', { query });
    return data?.data?.messages ?? data?.data ?? [];
  }

  /** 获取好友私聊历史消息 */
  async getFriendMsgHistory(userId, { count = 20, messageSeq = 0, reverseOrder = false } = {}) {
    const query = { user_id: userId, count, message_seq: messageSeq, reverseOrder };
    const data = await this._request('get_friend_msg_history', { query });
    return data?.data?.messages ?? data?.data ?? [];
  }

  /** 获取合并转发消息内容 */
  async getForwardMsg(messageId) {
    const data = await this._request('get_forward_msg', {
      query: { message_id: messageId },
    });
    return data?.data?.messages ?? data?.data ?? [];
  }

  /** 语音转文字（官方 NT 接口） */
  async voiceMsgToText(messageId) {
    const data = await this._request('voice_msg_to_text', {
      query: { message_id: messageId },
    });
    return data?.data?.text ?? null;
  }

  /** 发送戳一戳（双击头像） */
  async sendPoke({ groupId, userId, targetId }) {
    const body = {};
    if (groupId) body.group_id = groupId;
    if (userId) body.user_id = userId;
    if (targetId) body.target_id = targetId;
    const data = await this._request('send_poke', {
      method: 'POST',
      body,
      timeoutMs: this.sendTimeoutMs,
    });
    return data?.data ?? data;
  }

  /** 获取已加入的所有群列表 */
  async getGroupList(noCache = false) {
    const data = await this._request('get_group_list', { query: { no_cache: noCache } });
    return data?.data ?? [];
  }

  /** 获取指定群的详细信息 */
  async getGroupInfo(groupId) {
    const data = await this._request('get_group_info', { query: { group_id: groupId } });
    return data?.data ?? null;
  }

  /** 获取指定群的完整成员列表 */
  async getGroupMemberList(groupId, noCache = false) {
    const data = await this._request('get_group_member_list', {
      query: { group_id: groupId, no_cache: noCache },
    });
    return data?.data ?? [];
  }

  /** 获取指定群成员的具体信息（群名片、角色、头衔等） */
  async getGroupMemberInfo(groupId, userId, noCache = false) {
    const data = await this._request('get_group_member_info', {
      query: { group_id: groupId, user_id: userId, no_cache: noCache },
    });
    return data?.data ?? null;
  }

  /** 转发单条消息到群聊 */
  async forwardGroupSingleMsg(groupId, messageId) {
    const data = await this._request('forward_group_single_msg', {
      method: 'POST',
      body: { group_id: groupId, message_id: messageId },
      timeoutMs: this.sendTimeoutMs,
    });
    return data?.data ?? data;
  }

  /** 转发单条消息到好友私聊 */
  async forwardFriendSingleMsg(userId, messageId) {
    const data = await this._request('forward_friend_single_msg', {
      method: 'POST',
      body: { user_id: userId, message_id: messageId },
      timeoutMs: this.sendTimeoutMs,
    });
    return data?.data ?? data;
  }

  /** 获取群 AI 语音可用声色列表 */
  async getAiCharacters(groupId, chatType = 1) {
    const data = await this._request('get_ai_characters', {
      query: { group_id: groupId, chat_type: chatType },
    });
    return data?.data ?? [];
  }

  /** 发送群 AI 语音条 */
  async sendGroupAiRecord(groupId, character, text) {
    const data = await this._request('send_group_ai_record', {
      method: 'POST',
      body: { group_id: groupId, character, text },
      timeoutMs: this.sendTimeoutMs,
    });
    return data?.data ?? data;
  }

  /**
   * 发送消息。
   * @returns {{ status: 'ok'|'nt_event_timeout', raw: object }}
   *
   * 关键行为（迁移自 bridge.js:709-722）：NapCat 返回 "Timeout: NTEvent" 时，
   * 消息其实已经发出去了，只是回调确认超时。旧 Bridge 早期把它当失败重试，
   * 结果是群里复读。这里显式建模成一种成功。
   */
  async sendMessage({ isGroup, targetId, message }) {
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const body = isGroup ? { group_id: targetId, message } : { user_id: targetId, message };

    const data = await this._request(action, {
      method: 'POST',
      body,
      timeoutMs: this.sendTimeoutMs,
    });

    if (data && data.status === 'ok' && (!data.retcode || data.retcode === 0)) {
      return { status: 'ok', messageId: data.data?.message_id ?? null, raw: data };
    }

    if (typeof data?.message === 'string' && data.message.includes('Timeout: NTEvent')) {
      return { status: 'nt_event_timeout', messageId: null, raw: data };
    }

    throw new SendError(`NapCat ${action} 失败: ${JSON.stringify(data).slice(0, 300)}`);
  }
}
