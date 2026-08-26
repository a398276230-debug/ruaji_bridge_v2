#!/usr/bin/env node
/**
 * unified_host_mcp.mjs —— Unified AstrBot Host (LivingMemory / SelfLearning) 的 stdio MCP 桥接服务器。
 * 
 * 协议支持: JSON-RPC 2.0 (MCP 2024-11-05)
 * 路由逻辑:
 *   - tools/list: 动态从 http://127.0.0.1:8870/api/v1/tools 获取工具列表，并映射为 inputSchema
 *   - tools/call: 转发至 http://127.0.0.1:8870/api/v1/tools/call
 */

import { createInterface } from 'node:readline'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const HOST_BASE_URL = process.env.UNIFIED_HOST_URL || 'http://127.0.0.1:8870'
const TOOLS_MANIFEST_FALLBACK = process.env.UNIFIED_HOST_MANIFEST || 'F:/hermes-agent/unified_host_tools.json'
const PROTOCOL_VERSION = '2024-11-05'

async function fetchManifest() {
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

async function callTool(name, args) {
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
          version: '1.0.0',
        },
      })
      break
    }

    case 'ping': {
      sendResponse(id, {})
      break
    }

    case 'tools/list': {
      const manifest = await fetchManifest()
      const tools = (manifest.tools || []).map(t => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.parameters || { type: 'object', properties: {} },
      }))
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
