/**
 * web/proxy.js — 本地插件通用反向代理网关
 *
 * 彻底根治 iframe 跨域安全头拦截（X-Frame-Options / Content-Security-Policy）：
 * 1. 仅限代理到 127.0.0.1 上的本地服务（杜绝外网 SSRF）
 * 2. 自动清洗阻止 iframe 嵌入的响应头（X-Frame-Options、CSP frame-ancestors）
 * 3. 透传请求体、查询参数、状态码与响应流
 */

import http from 'node:http';

export function handlePluginProxy(req, res, pathname) {
  // 匹配 /proxy/plugin/<port>/<subpath>
  const match = pathname.match(/^\/proxy\/plugin\/(\d+)(\/.*)?$/);
  if (!match) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '无效的代理路径，格式必须为 /proxy/plugin/<port>/<path>' }));
    return;
  }

  const port = parseInt(match[1], 10);
  const subpath = match[2] || '/';
  const url = new URL(req.url, 'http://localhost');
  const targetPath = subpath + (url.search || '');

  // 端口安全范围限制：仅限非特权本地端口 (1024 - 65535)
  if (isNaN(port) || port < 1024 || port > 65535) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '禁止代理到受保护系统端口' }));
    return;
  }

  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${port}`;
  // 避免 gzip 解压麻烦或直接透传
  delete headers['accept-encoding'];

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: targetPath,
      method: req.method,
      headers,
      timeout: 10000,
    },
    (proxyRes) => {
      const respHeaders = { ...proxyRes.headers };

      // 核心：彻底剥离和清洗阻止 iframe 嵌入的安全头
      delete respHeaders['x-frame-options'];
      delete respHeaders['content-security-policy'];
      delete respHeaders['content-security-policy-report-only'];

      respHeaders['access-control-allow-origin'] = '*';

      const contentType = (respHeaders['content-type'] || '').toLowerCase();
      if (contentType.includes('text/html')) {
        delete respHeaders['content-length'];
        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8');
          const baseTag = `<base href="http://127.0.0.1:${port}/">`;
          if (html.includes('<head>')) {
            html = html.replace('<head>', `<head>\n  ${baseTag}`);
          } else if (html.includes('<HEAD>')) {
            html = html.replace('<HEAD>', `<HEAD>\n  ${baseTag}`);
          } else {
            html = baseTag + html;
          }
          res.writeHead(proxyRes.statusCode || 200, respHeaders);
          res.end(html);
        });
        return;
      }

      res.writeHead(proxyRes.statusCode || 200, respHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <div style="font-family: sans-serif; padding: 24px; color: #e5e7eb; background: #1f2937; border-radius: 8px; margin: 16px;">
          <h3 style="color: #f87171; margin-top: 0;">🔌 插件服务未连接或未就绪</h3>
          <p>无法连接到本地端口 <code>127.0.0.1:${port}</code> (${err.message})</p>
          <p style="color: #9ca3af; font-size: 13px;">请检查该插件是否已在统一宿主中成功装配并启动。</p>
        </div>
      `);
    }
  });

  req.pipe(proxyReq);
}
