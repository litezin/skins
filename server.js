const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const CONFIG_PATH = path.resolve(__dirname, 'skin-config.toml');
const DEFAULT_PORT = 3000;
const SKINS_DIR = path.resolve(__dirname, 'skins');

function parseTomlConfig(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  let inSection = false;
  const config = {};

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    if (line === '["Somake Skin Config"]') {
      inSection = true;
      continue;
    }

    if (!inSection) continue;
    if (/^\[.*\]$/.test(line)) break;

    const match = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();

    if (/^".*"$/.test(value)) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    } else if (/^(true|false)$/i.test(value)) {
      value = value.toLowerCase() === 'true';
    } else if (!Number.isNaN(Number(value))) {
      value = Number(value);
    }

    config[key] = value;
  }

  if (!inSection) {
    throw new Error('Configuração "Somake Skin Config" não encontrada em ' + filePath);
  }

  return {
    apiEndpoint: String(config.apiEndpoint || '').trim(),
    apiAuthHeader: String(config.apiAuthHeader || '').trim(),
    apiAuthValue: String(config.apiAuthValue || '').trim(),
    apiConnectTimeoutMs: Number(config.apiConnectTimeoutMs || 5000),
    apiReadTimeoutMs: Number(config.apiReadTimeoutMs || 10000),
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https:') ? https : http;
    const request = protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        return;
      }

      const contentType = response.headers['content-type'];
      if (!contentType || !contentType.startsWith('image/')) {
        reject(new Error('URL não aponta para uma imagem válida'));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ buffer, contentType });
      });
    });

    request.on('error', reject);
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('Timeout ao baixar imagem'));
    });
  });
}

async function saveSkinImage(playerUuid, imageBuffer, contentType) {
  const extension = contentType === 'image/png' ? 'png' : 'jpg';
  const filename = `${playerUuid}.${extension}`;
  const filepath = path.join(SKINS_DIR, filename);

  if (!fs.existsSync(SKINS_DIR)) {
    fs.mkdirSync(SKINS_DIR, { recursive: true });
  }

  fs.writeFileSync(filepath, imageBuffer);
  return filename;
}

async function handleMirror(req, res, config) {
  try {
    const body = await readRequestBody(req);
    if (!body || typeof body !== 'object') {
      return sendJson(res, 400, { error: 'Payload JSON inválido' });
    }

    const { playerUuid, sourceUrl } = body;
    if (!playerUuid || !sourceUrl) {
      return sendJson(res, 400, {
        error: 'Os campos playerUuid e sourceUrl são obrigatórios',
      });
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(playerUuid)) {
      return sendJson(res, 400, { error: 'playerUuid deve ser um UUID válido' });
    }

    const { buffer, contentType } = await downloadImage(sourceUrl);
    const filename = await saveSkinImage(playerUuid, buffer, contentType);

    const baseUrl = process.env.PUBLIC_URL || `https://litezin.github.io/skins/`;
    const publicUrl = `${baseUrl}/skins/${filename}`;

    console.log(`[mirror] uuid=${playerUuid} -> ${publicUrl}`);
    sendJson(res, 200, { publicUrl });
  } catch (error) {
    console.error(`[ERRO mirror] ${error.message}`);
    sendJson(res, 502, {
      error: 'Erro ao processar espelhamento de skin',
      details: error.message,
    });
  }
}

function createServer(config) {
  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const route = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';

    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);

    if (req.method === 'GET' && route === '/health') {
      return sendJson(res, 200, { status: 'ok' });
    }

    if (req.method === 'GET' && route === '/skins') {
      const files = fs.existsSync(SKINS_DIR)
        ? fs.readdirSync(SKINS_DIR).filter((name) => /\.(png|jpg)$/i.test(name))
        : [];

      const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || DEFAULT_PORT}`;
      const rows = files
        .map((name) => {
          const url = `${baseUrl}/skins/${encodeURIComponent(name)}`;
          return `<li><a href="${url}">${name}</a></li>`;
        })
        .join('');

      const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>Skins</title>
</head>
<body>
  <h1>Skins</h1>
  <ul>${rows}</ul>
</body>
</html>`;

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html, 'utf8'),
      });
      res.end(html);
      return;
    }

    // Serve skin images
    if (req.method === 'GET' && req.url.startsWith('/skins/')) {
      // Extrai apenas o nome do arquivo até a extensão (.png ou .jpg),
      // ignorando tudo que vier depois (query string, fragmentos, etc.)
      // Ex: /skins/uuid.png?t=123  →  redireciona para  /skins/uuid.png
      const rawPath = req.url.split('?')[0]; // remove query string
      const filename = path.basename(rawPath);
      const cleanFilename = filename.replace(/\.(png|jpg)(.*)/i, '.$1'); // remove sufixo após extensão

      // Se havia sujeira na URL, redireciona para a versão limpa
      if (filename !== cleanFilename || req.url !== rawPath) {
        const cleanUrl = `/skins/${cleanFilename}`;
        console.log(`[skins] redirect "${req.url}" -> "${cleanUrl}"`);
        res.writeHead(301, { Location: cleanUrl });
        res.end();
        return;
      }

      const filepath = path.join(SKINS_DIR, cleanFilename);
      console.log(`[skins] filename="${cleanFilename}" filepath="${filepath}"`);

      if (!fs.existsSync(filepath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Skin não encontrada');
        return;
      }

      const stat = fs.statSync(filepath);
      const contentType = cleanFilename.endsWith('.png') ? 'image/png' : 'image/jpeg';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=31536000',
      });

      fs.createReadStream(filepath).pipe(res);
      return;
    }

    const validMirrorRoutes = ['/mirror', '/api/skins/mirror'];
    if (req.method === 'POST' && validMirrorRoutes.includes(route)) {
      return handleMirror(req, res, config);
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Rota não encontrada' }));
  });
}

function main() {
  const config = parseTomlConfig(CONFIG_PATH);

  const port = Number(process.env.PORT || DEFAULT_PORT);
  const server = createServer(config);
  server.listen(port, () => {
    console.log(`Servidor de mirror de skins iniciado em http://localhost:${port}`);
    console.log(`Skins serão salvas em: ${SKINS_DIR}`);
  });
}

main();
