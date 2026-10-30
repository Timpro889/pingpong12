#!/usr/bin/env node
// lan-server.js — 零依赖「本地中转 + 静态服务器」，用于局域网一键联机（客人扫一次、主机自动回扫）
//
// 为什么需要它：WebRTC 必须双向交换 SDP（offer + answer）。完全没有服务器时只能靠人手扫两次码。
// 这个脚本在局域网内某台机器（比如你的笔记本）上跑一个极轻量的信令中转：
//   - 给浏览器提供静态游戏文件（index.html / net.js / qrcode.js / jsqr.js / assets/*）
//   - 提供 /signal/<房间> 端点，只负责把一方的 SDP 转发给另一方（内存态，不出局域网，不落地）
// 真正打球的数据仍走 WebRTC 浏览器直连，不经此服务器。不依赖任何公网 / 云服务器。
//
// 用法：
//   cd pingpong-go
//   node lan-server.js
//   然后用「本机访问」地址在自己浏览器开游戏 → 联机对战 → 创建房间 → 手机扫终端里「手机扫码」的二维码。
//
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

// 房间信令：roomId -> { clients:Set<SSE响应>, buf:[最近几条消息] }
const rooms = new Map();

function lanIPv4() {
  const ifs = os.networkInterfaces();
  for (const k in ifs) {
    for (const a of ifs[k]) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}
const LAN = 'http://' + lanIPv4() + ':' + PORT;
const LOCAL = 'http://localhost:' + PORT;

function sendJSON(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(s);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found: ' + urlPath); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];

  // 能力探测：游戏前端靠它判断是否处于「本地中转」模式
  if (u === '/__relay') {
    return sendJSON(res, 200, { relay: true, lan: LAN, local: LOCAL });
  }

  // 信令端点：/signal/<房间>
  const m = u.match(/^\/signal\/([^/]+)$/);
  if (m) {
    const roomId = decodeURIComponent(m[1]);
    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      if (!rooms.has(roomId)) rooms.set(roomId, { clients: new Set(), buf: [] });
      const room = rooms.get(roomId);
      room.clients.add(res);
      // 回放缓冲：后加入的一方也能拿到对方已发出的 offer / answer
      room.buf.forEach((msg) => { try { res.write('data: ' + JSON.stringify(msg) + '\n\n'); } catch (e) {} });
      req.on('close', () => room.clients.delete(res));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let obj;
        try { obj = JSON.parse(body); } catch (e) { res.writeHead(400); res.end('bad json'); return; }
        if (!rooms.has(roomId)) rooms.set(roomId, { clients: new Set(), buf: [] });
        const room = rooms.get(roomId);
        room.buf.push(obj);
        if (room.buf.length > 8) room.buf.shift();
        const data = 'data: ' + JSON.stringify(obj) + '\n\n';
        room.clients.forEach((r) => { try { r.write(data); } catch (e) {} });
        res.writeHead(204);
        res.end();
      });
      return;
    }
  }

  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  一二布布·乒乓球 — 局域网一键联机中转已启动');
  console.log('  ─────────────────────────────────────────');
  console.log('  本机访问 : ' + LOCAL);
  console.log('  手机扫码 : ' + LAN + '   （需与电脑在同一 WiFi）');
  console.log('  ─────────────────────────────────────────');
  console.log('  步骤：在自己浏览器打开「本机访问」地址 → 联机对战 → 创建房间 → 手机扫二维码即可自动握手。\n');
});
