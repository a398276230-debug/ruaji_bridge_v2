#!/usr/bin/env node
/**
 * unified_host_mcp.mjs —— Unified Host & OneBot Tools 的 stdio MCP 桥接服务器。
 * 
 * 协议支持: JSON-RPC 2.0 (MCP 2024-11-05)
 * 路由逻辑:
 *   - OneBot 协议工具 (21 个): 由 Bridge 本地 OneBotToolsExecutor 直连 NapCat 执行，零延迟、高稳定性
 *   - 记忆与知识图谱工具 (4 个): 转发至 Python 统一宿主 http://127.0.0.1:8870/api/v1/tools/call
 *   - tools/list: 动态合并两端清单，完整暴露 25 个 MCP 工具
 */

import { createInterface } from 'node:readline'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OneBotToolsExecutor, ONEBOT_TOOLS_MANIFEST } from '../src/tools/onebot-tools.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOST_BASE_URL = process.env.UNIFIED_HOST_URL || 'http://127.0.0.1:8870'
const TOOLS_MANIFEST_FALLBACK = process.env.UNIFIED_HOST_MANIFEST || 'F:/hermes-agent/unified_host_tools.json'
const PROTOCOL_VERSION = '2024-11-05'

const onebotExecutor = new OneBotToolsExecutor()

async function fetchHostManifest() {
  try {
    const res = await fetch(`${HOST_BASE_URL}/api/v1/tools`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      return await res.json()
    }
  } catch {
    // 忽略网络错误，走本地 fallback
  }

  if (existsSync(TOOLS_MANIFEST_FALLBACK)) {
    try {
      const raw = readFileSync(TOOLS_MANIFEST_FALLBACK, 'utf-8')
      return JSON.parse(raw)
    } catch {
      // ignore
    }
  }

  return { tools: [] }
}

async function getCombinedToolsList() {
  const hostManifest = await fetchHostManifest()
  const hostTools = hostManifest.tools || []

  const map = new Map()
  // 1. 先载入 OneBot 原生工具清单
  for (const t of ONEBOT_TOOLS_MANIFEST) {
    map.set(t.name, {
      name: t.name,
      description: t.description || '',
      inputSchema: t.parameters || { type: 'object', properties: {} },
    })
  }

  // 2. 载入宿主记忆/图谱工具
  for (const t of hostTools) {
    if (!map.has(t.name)) {
      map.set(t.name, {
        name: t.name,
        description: t.description || '',
        inputSchema: t.parameters || { type: 'object', properties: {} },
      })
    }
  }

  return Array.from(map.values())
}

async function callTool(name, args) {
  // 1. OneBot 工具直连执行
  if (onebotExecutor.isSupported(name)) {
    return await onebotExecutor.execute(name, args)
  }

  // 2. 记忆/图谱工具转发至统一宿主
  try {
    const res = await fetch(`${HOST_BASE_URL}/api/v1/tools/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args || {} }),
      signal: AbortSignal.timeout(60000),
    })
    const json = await res.json()
    return json
  } catch (err) {
    return {
      ok: false,
      error: 'http_request_failed',
      message: `无法连接统一宿主 (${HOST_BASE_URL}): ${err.message}`,
    }
  }
}

function sendResponse(id, result, error) {
  const msg = { jsonrpc: '2.0', id }
  if (error) {
    msg.error = error
  } else {
    msg.result = result
  }
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return
  const { id, method, params } = message

  // Notifications
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      // Client confirmed initialization
    }
    return
  }

  switch (method) {
    case 'initialize': {
      sendResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'unified-astrbot-host',
          version: '2.0.0',
        },
      })
      break
    }

    case 'ping': {
      sendResponse(id, {})
      break
    }

    case 'tools/list': {
      const tools = await getCombinedToolsList()
      sendResponse(id, { tools })
      break
    }

    case 'tools/call': {
      const toolName = params?.name
      const toolArgs = params?.arguments || {}
      if (!toolName) {
        sendResponse(id, null, {
          code: -32602,
          message: 'Missing tool name',
        })
        break
      }

      const result = await callTool(toolName, toolArgs)
      sendResponse(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: result.ok === false,
      })
      break
    }

    default: {
      sendResponse(id, null, {
        code: -32601,
        message: `Method not found: ${method}`,
      })
      break
    }
  }
}

function main() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  })

  rl.on('line', line => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const message = JSON.parse(trimmed)
      handleMessage(message).catch(err => {
        if (message.id !== undefined) {
          sendResponse(message.id, null, {
            code: -32603,
            message: `Internal error: ${err.message}`,
          })
        }
      })
    } catch {
      // Invalid JSON
      sendResponse(null, null, {
        code: -32700,
        message: 'Parse error',
      })
    }
  })
}

main()
