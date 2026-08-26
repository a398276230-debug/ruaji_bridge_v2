/**
 * web/api/plugins-config.js — 插件动态 Schema 与配置中心 API
 *
 * 类似 AstrBot 的插件配置机制：
 * 1. 扫描各插件目录中的 _conf_schema.json（声明式配置规范）
 * 2. 对应读取 data/plugin_data/<plugin>/config.json（实际配置项）
 * 3. 前端据此动态渲染配置表单，保存时热更新并持久化
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 插件名只允许字母/数字/下划线/连字符/点，且不得是 . 或 ..
 * 挡住 ../../ 形式的目录穿越——路径段直接来自 URL，必须校验后才能拼进 fs 调用。
 */
function isSafePluginName(name) {
  return /^[\w.-]+$/.test(name) && name !== '.' && name !== '..';
}

export function createPluginsConfigApi(deps) {
  const { config, logger } = deps;
  const log = logger?.child({ component: 'web-plugins-config' }) ?? console;
  const rootDir = config?.paths?.rootDir || path.resolve('.');

  return {
    /** 列出所有发现的插件及其配置 Schema 与当前值 */
    'GET /api/plugins/configs': async () => {
      const pluginDirs = [
        path.resolve(rootDir, 'astr'),
        path.resolve(rootDir, 'data/plugin_data'),
      ];

      const results = {};

      // 扫描 astr 目录下的插件
      const astrDir = path.resolve(rootDir, 'astr');
      if (fs.existsSync(astrDir)) {
        try {
          const entries = fs.readdirSync(astrDir, { withFileTypes: true });
          for (const ent of entries) {
            if (ent.isDirectory() && !ent.name.startsWith('.')) {
              const pDir = path.join(astrDir, ent.name);
              const schemaFile = path.join(pDir, '_conf_schema.json');
              const dataConfigFile = path.join(rootDir, 'data/plugin_data', ent.name, 'config.json');

              let schema = null;
              let currentConfig = {};

              if (fs.existsSync(schemaFile)) {
                try {
                  schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
                } catch (e) {
                  log.warn('解析插件 schema 失败', { plugin: ent.name, error: e.message });
                }
              }

              if (fs.existsSync(dataConfigFile)) {
                try {
                  currentConfig = JSON.parse(fs.readFileSync(dataConfigFile, 'utf8'));
                } catch {
                  currentConfig = {};
                }
              }

              if (schema) {
                results[ent.name] = {
                  name: ent.name,
                  schema,
                  config: currentConfig,
                  dataPath: dataConfigFile,
                };
              }
            }
          }
        } catch (err) {
          log.error('扫描插件目录失败', { error: err.message });
        }
      }

      return {
        body: {
          plugins: results,
          total: Object.keys(results).length,
        },
      };
    },

    /** 读取单个插件配置与 Schema */
    'GET /api/plugins/configs/*': async ({ pathname }) => {
      const pluginName = pathname.slice('/api/plugins/configs/'.length).trim();
      if (!pluginName) return { status: 400, body: { error: '缺少插件名' } };
      if (!isSafePluginName(pluginName)) {
        return { status: 400, body: { error: '插件名非法' } };
      }

      const schemaFile = path.resolve(rootDir, 'astr', pluginName, '_conf_schema.json');
      const dataConfigFile = path.resolve(rootDir, 'data/plugin_data', pluginName, 'config.json');

      if (!fs.existsSync(schemaFile)) {
        return { status: 404, body: { error: `未找到插件 ${pluginName} 的 _conf_schema.json` } };
      }

      let schema = {};
      let currentConfig = {};
      try {
        schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
      } catch (err) {
        return { status: 500, body: { error: `Schema 解析失败: ${err.message}` } };
      }

      if (fs.existsSync(dataConfigFile)) {
        try {
          currentConfig = JSON.parse(fs.readFileSync(dataConfigFile, 'utf8'));
        } catch {
          currentConfig = {};
        }
      }

      return {
        body: {
          name: pluginName,
          schema,
          config: currentConfig,
        },
      };
    },

    /** 保存单个插件配置 */
    'PUT /api/plugins/configs/*': async ({ pathname, body }) => {
      const pluginName = pathname.slice('/api/plugins/configs/'.length).trim();
      if (!pluginName) return { status: 400, body: { error: '缺少插件名' } };
      if (!isSafePluginName(pluginName)) {
        return { status: 400, body: { error: '插件名非法' } };
      }
      if (!body || typeof body !== 'object') {
        return { status: 400, body: { error: '请求体必须是 JSON 对象' } };
      }

      const dataDir = path.resolve(rootDir, 'data/plugin_data', pluginName);
      const dataConfigFile = path.join(dataDir, 'config.json');

      try {
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        const tmpFile = `${dataConfigFile}.tmp`;
        fs.writeFileSync(tmpFile, JSON.stringify(body, null, 2), 'utf8');
        fs.renameSync(tmpFile, dataConfigFile);

        log.info('插件配置已更新保存', { plugin: pluginName, file: dataConfigFile });
        return {
          body: {
            ok: true,
            name: pluginName,
            config: body,
          },
        };
      } catch (err) {
        log.error('保存插件配置失败', { plugin: pluginName, error: err.message });
        return { status: 500, body: { error: `保存失败: ${err.message}` } };
      }
    },
  };
}
