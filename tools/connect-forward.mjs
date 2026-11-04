// 临时本地 CONNECT 转发器:把发往 github.com:443 的隧道借道 api.github.com 的 IP。
// 用法: node tools/connect-forward.mjs [转发目标IP] [本地端口]
import net from 'node:net';

const TARGET_IP = process.argv[2] || '20.205.243.168';
const LOCAL_PORT = +(process.argv[3] || 9443);

const server = net.createServer((client) => {
  let upstream = null;
  client.on('data', (chunk) => {
    if (upstream) { upstream.write(chunk); return; }
    const head = chunk.toString('latin1');
    if (!/^CONNECT\s/i.test(head)) { client.destroy(); return; }
    const m = head.match(/^CONNECT\s+([^:\s]+):(\d+)/);
    const port = +(m?.[2] || 443);
    upstream = net.connect({ host: TARGET_IP, port }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const idx = head.indexOf('\r\n\r\n');
      if (idx >= 0) {
        const rest = chunk.subarray(idx + 4);
        if (rest.length) upstream.write(rest);
      }
    });
    upstream.on('data', (d) => { try { client.write(d); } catch { } });
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => client.destroy());
  });
  client.on('error', () => { try { upstream?.destroy(); } catch { } });
  client.on('close', () => { try { upstream?.destroy(); } catch { } });
});
server.listen(LOCAL_PORT, '127.0.0.1', () => console.log(`CONNECT forwarder 127.0.0.1:${LOCAL_PORT} -> ${TARGET_IP}:443`));
