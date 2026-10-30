// net.js — 局域网 PvP 通信层（WebRTC DataChannel）
// 设计：无服务器、无 STUN。两端用「扫码 / 粘贴」手动交换一次 SDP（房间码/应答码），
// 连接建立后游戏数据在两端浏览器之间直连。主机权威模拟并向客人广播状态，客人只发自己球拍位置。
(function () {
  'use strict';
  var Net = {
    role: null, dc: null, pc: null,
    onMessage: null, onConnected: null, onStatus: null
  };
  function status(t) { if (Net.onStatus) Net.onStatus(t); else if (t) console.log('[net]', t); }

  /* ---------- 字节 / base64 ---------- */
  function bytesToB64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function b64ToBytes(b64) { var s = atob(b64); var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  var TE = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
  var TD = (typeof TextDecoder !== 'undefined') ? new TextDecoder() : null;
  function hasGzip() { return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'; }
  function gzipBytes(b) { return new Response(new Blob([b]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer().then(function (ab) { return new Uint8Array(ab); }); }
  function gunzipBytes(b) { return new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer().then(function (ab) { return new Uint8Array(ab); }); }

  async function encode(obj) {
    var json = JSON.stringify(obj);
    if (hasGzip()) { try { return 'G' + bytesToB64(await gzipBytes(TE.encode(json))); } catch (e) {} }
    return 'R' + bytesToB64(TE.encode(json));
  }
  async function decode(code) {
    var tag = code.charAt(0), body = code.slice(1);
    var bytes = b64ToBytes(body);
    if (tag === 'G' && hasGzip()) { try { bytes = await gunzipBytes(bytes); } catch (e) {} }
    return JSON.parse(TD.decode(bytes));
  }

  /* ---------- SDP 精简：只保留局域网 IPv4 / mDNS host 候选，缩小房间码 ----------
     去掉 IPv6 link-local、公网、srflx/relay 候选，房间码从数 KB 降到几百字节，扫码更稳。 */
  function cleanSDP(sdp) {
    var lines = sdp.split('\r\n'), out = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ln.indexOf('a=candidate:') === 0) {
        if (/typ host/.test(ln)) {
          var addr = (ln.split(' ')[4]) || '';
          if (/\.local$/.test(addr)) { out.push(ln); continue; }
          if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr)) { out.push(ln); continue; }
          continue; // 丢弃 IPv6 link-local / 其他
        }
        continue;   // 丢弃 srflx / relay / prflx
      }
      out.push(ln);
    }
    return out.join('\r\n');
  }

  function makePC() {
    var pc = new RTCPeerConnection({ iceServers: [] });
    Net.pc = pc;
    pc.oniceconnectionstatechange = function () {
      var s = pc.iceConnectionState;
      status('连接状态：' + s);
      if (s === 'failed') status('连接失败，请确认两台设备在同一 WiFi');
    };
    return pc;
  }
  function gatherComplete(pc) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') { resolve(); return; }
      var done = false;
      function fin() { if (done) return; done = true; pc.removeEventListener('icegatheringstatechange', chk); resolve(); }
      function chk() { if (pc.iceGatheringState === 'complete') fin(); }
      pc.addEventListener('icegatheringstatechange', chk);
      setTimeout(fin, 1500);
    });
  }
  function wireChannel(dc, role) {
    dc.onopen = function () { Net.dc = dc; Net.role = role; status('已连接 ✔'); if (Net.onConnected) Net.onConnected(role); };
    dc.onclose = function () { Net.dc = null; status('连接已断开'); };
    dc.onmessage = function (e) { try { var m = JSON.parse(e.data); if (Net.onMessage) Net.onMessage(m); } catch (_) {} };
  }

  // 主机：创建房间（数据通道 + offer）
  Net.createRoom = async function () {
    var pc = makePC();
    var dc = pc.createDataChannel('game', { ordered: true });
    wireChannel(dc, 'host');
    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await gatherComplete(pc);
    return await encode({ t: 'offer', sdp: cleanSDP(pc.localDescription.sdp) });
  };
  // 客人：加入房间（解析 offer → answer）
  Net.joinRoom = async function (offerCode) {
    var data = await decode(offerCode.trim());
    if (data.t !== 'offer') throw new Error('房间码无效');
    var pc = makePC();
    pc.ondatachannel = function (ev) { wireChannel(ev.channel, 'guest'); };
    await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
    var answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await gatherComplete(pc);
    return await encode({ t: 'answer', sdp: cleanSDP(pc.localDescription.sdp) });
  };
  // 主机：收应答码，完成连接
  Net.completeHost = async function (answerCode) {
    var data = await decode(answerCode.trim());
    if (data.t !== 'answer') throw new Error('应答码无效');
    await Net.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    status('已收到应答，正在建立直连…');
  };
  Net.send = function (obj) {
    if (Net.dc && Net.dc.readyState === 'open') { try { Net.dc.send(JSON.stringify(obj)); } catch (e) {} }
  };
  Net.close = function () {
    try { if (Net.dc) Net.dc.close(); } catch (e) {}
    try { if (Net.pc) Net.pc.close(); } catch (e) {}
    Net.dc = null; Net.pc = null; Net.role = null;
  };

  window.Net = Net;
})();
