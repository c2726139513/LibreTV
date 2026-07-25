// /cloud-functions/api/proxy/[[path]].mjs
// EdgeOne Cloud Function: Video proxy with M3U8 processing
// Rewrites from edgeone.json route /proxy/:path* to this function
// Uses Node.js built-in fetch (available in Node 18+)

import crypto from 'crypto';

// ─── Configuration (from environment) ────────────────────────────────────────

function getConfig(env) {
  return {
    debug: env.DEBUG === 'true',
    cacheTtl: parseInt(env.CACHE_TTL || '86400', 10),
    maxRecursion: parseInt(env.MAX_RECURSION || '5', 10),
    userAgents: parseUserAgents(env.USER_AGENTS_JSON),
  };
}

function parseUserAgents(json) {
  const defaults = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  ];
  if (!json) return defaults;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : defaults;
  } catch {
    return defaults;
  }
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(ctx, message) {
  if (ctx.config.debug) {
    console.log(`[EdgeOne Proxy] ${message}`);
  }
}

// ─── Auth ────────────────────────────────────────────────────────────────────

function validateAuth(requestUrl, env) {
  const authHash = requestUrl.searchParams.get('auth');
  const timestamp = requestUrl.searchParams.get('t');
  const serverPassword = env.PASSWORD;

  if (!serverPassword) {
    console.error('[EdgeOne Proxy] PASSWORD not set, proxy access denied');
    return false;
  }

  const serverHash = crypto.createHash('sha256').update(serverPassword).digest('hex');

  if (!authHash || authHash !== serverHash) {
    console.warn('[EdgeOne Proxy] Auth failed: hash mismatch');
    return false;
  }

  if (timestamp) {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 minutes
    if (now - parseInt(timestamp, 10) > maxAge) {
      console.warn('[EdgeOne Proxy] Auth failed: timestamp expired');
      return false;
    }
  }

  return true;
}

// ─── URL Helpers ─────────────────────────────────────────────────────────────

function getTargetUrlFromPath(encodedPath) {
  if (!encodedPath) return null;
  try {
    const decoded = decodeURIComponent(encodedPath);
    if (/^https?:\/\/.+/i.test(decoded)) return decoded;
    if (/^https?:\/\/.+/i.test(encodedPath)) return encodedPath;
    return null;
  } catch {
    return null;
  }
}

function getBaseUrl(urlStr) {
  if (!urlStr) return '';
  try {
    const parsed = new URL(urlStr);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length <= 1) return `${parsed.origin}/`;
    segments.pop();
    return `${parsed.origin}/${segments.join('/')}/`;
  } catch {
    const lastSlash = urlStr.lastIndexOf('/');
    if (lastSlash > urlStr.indexOf('://') + 2) {
      return urlStr.substring(0, lastSlash + 1);
    }
    return urlStr + '/';
  }
}

function resolveUrl(baseUrl, relativeUrl) {
  if (!relativeUrl) return '';
  if (/^https?:\/\//i.test(relativeUrl)) return relativeUrl;
  if (!baseUrl) return relativeUrl;
  try {
    return new URL(relativeUrl, baseUrl).toString();
  } catch {
    if (relativeUrl.startsWith('/')) {
      try { return new URL(relativeUrl, baseUrl).origin + relativeUrl; } catch { return relativeUrl; }
    }
    return `${baseUrl.replace(/\/[^/]*$/, '/')}${relativeUrl}`;
  }
}

function getRandomUserAgent(agents) {
  return agents[Math.floor(Math.random() * agents.length)];
}

// ─── Content Fetching ────────────────────────────────────────────────────────

async function fetchContentWithType(targetUrl, cfg) {
  const headers = {
    'User-Agent': getRandomUserAgent(cfg.userAgents),
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: new URL(targetUrl).origin,
  };

  log(cfg, `Fetching: ${targetUrl}`);

  const response = await fetch(targetUrl, { headers, redirect: 'follow' });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`HTTP ${response.status}: ${response.statusText}. ${body.substring(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  const content = await response.text();
  const contentType = response.headers.get('content-type') || '';

  log(cfg, `Fetched: ${targetUrl}, Type: ${contentType}, Length: ${content.length}`);

  return { content, contentType };
}

// ─── M3U8 Processing ─────────────────────────────────────────────────────────

function isM3u8Content(content, contentType) {
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes('application/vnd.apple.mpegurl') ||
        ct.includes('application/x-mpegurl') ||
        ct.includes('audio/mpegurl')) {
      return true;
    }
  }
  return typeof content === 'string' && content.trim().startsWith('#EXTM3U');
}

function rewriteUrlToProxy(targetUrl) {
  if (!targetUrl) return '';
  return `/proxy/${encodeURIComponent(targetUrl)}`;
}

function processKeyLine(line, baseUrl) {
  return line.replace(/URI="([^"]+)"/, (match, uri) => {
    const absolute = resolveUrl(baseUrl, uri);
    return `URI="${rewriteUrlToProxy(absolute)}"`;
  });
}

function processMapLine(line, baseUrl) {
  return line.replace(/URI="([^"]+)"/, (match, uri) => {
    const absolute = resolveUrl(baseUrl, uri);
    return `URI="${rewriteUrlToProxy(absolute)}"`;
  });
}

function processMediaPlaylist(url, content, cfg) {
  const baseUrl = getBaseUrl(url);
  const lines = content.split('\n');
  const output = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line && i === lines.length - 1) { output.push(line); continue; }
    if (!line) continue;

    if (line.startsWith('#EXT-X-KEY')) {
      output.push(processKeyLine(line, baseUrl));
    } else if (line.startsWith('#EXT-X-MAP')) {
      output.push(processMapLine(line, baseUrl));
    } else if (line.startsWith('#')) {
      output.push(line);
    } else {
      const absolute = resolveUrl(baseUrl, line);
      log(cfg, `Media segment: ${line} -> ${absolute}`);
      output.push(rewriteUrlToProxy(absolute));
    }
  }

  return output.join('\n');
}

async function processM3u8Content(targetUrl, content, recursionDepth, cfg) {
  if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
    log(cfg, `Master playlist detected: ${targetUrl}`);
    return processMasterPlaylist(targetUrl, content, recursionDepth, cfg);
  }
  log(cfg, `Media playlist detected: ${targetUrl}`);
  return processMediaPlaylist(targetUrl, content, cfg);
}

async function processMasterPlaylist(url, content, recursionDepth, cfg) {
  if (recursionDepth > cfg.maxRecursion) {
    throw new Error(`Max recursion depth (${cfg.maxRecursion}) exceeded: ${url}`);
  }

  const baseUrl = getBaseUrl(url);
  const lines = content.split('\n');
  let highestBandwidth = -1;
  let bestVariantUrl = '';

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      let variantLine = '';
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (l && !l.startsWith('#')) { variantLine = l; i = j; break; }
      }
      if (variantLine && bw >= highestBandwidth) {
        highestBandwidth = bw;
        bestVariantUrl = resolveUrl(baseUrl, variantLine);
      }
    }
  }

  if (!bestVariantUrl) {
    log(cfg, `No BANDWIDTH found, trying first URI in: ${url}`);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l && !l.startsWith('#') && /\.m3u8($|\?)/i.test(l)) {
        bestVariantUrl = resolveUrl(baseUrl, l);
        break;
      }
    }
  }

  if (!bestVariantUrl) {
    log(cfg, `No variant found, treating as media: ${url}`);
    return processMediaPlaylist(url, content, cfg);
  }

  log(cfg, `Selected variant (BW: ${highestBandwidth}): ${bestVariantUrl}`);
  const { content: variantContent, contentType: variantType } = await fetchContentWithType(bestVariantUrl, cfg);

  if (!isM3u8Content(variantContent, variantType)) {
    log(cfg, `Variant is not M3U8, treating as media: ${bestVariantUrl}`);
    return processMediaPlaylist(bestVariantUrl, variantContent, cfg);
  }

  return processM3u8Content(bestVariantUrl, variantContent, recursionDepth + 1, cfg);
}

// ─── Response Helpers ────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

// ─── Main Handler ────────────────────────────────────────────────────────────

export default async function onRequest(context) {
  const { request, env, params } = context;
  const cfg = getConfig(env);

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(),
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Only GET and HEAD are supported
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  const requestUrl = new URL(request.url);

  // Verify auth
  if (!validateAuth(requestUrl, env)) {
    return jsonResponse({
      success: false,
      error: '代理访问未授权：请检查密码配置或鉴权参数',
    }, 401);
  }

  // Extract target URL from path
  // URL is /api/proxy/<encoded-url> after rewrite; strip /api/proxy/ prefix
  const encodedPath = requestUrl.pathname.replace(/^\/api\/proxy\//, '');
  const targetUrl = getTargetUrlFromPath(encodedPath);

  if (!targetUrl) {
    return jsonResponse({
      success: false,
      error: 'Invalid proxy request path',
    }, 400);
  }

  log(cfg, `Proxy request: ${targetUrl}`);

  try {
    const { content, contentType } = await fetchContentWithType(targetUrl, cfg);

    // Process M3U8 content
    if (isM3u8Content(content, contentType)) {
      log(cfg, `Processing M3U8: ${targetUrl}`);
      const processed = await processM3u8Content(targetUrl, content, 0, cfg);

      return new Response(processed, {
        status: 200,
        headers: {
          ...corsHeaders(),
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': `public, max-age=${cfg.cacheTtl}`,
        },
      });
    }

    // Non-M3U8: return as-is
    return new Response(content, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': contentType || 'application/octet-stream',
        'Cache-Control': `public, max-age=${cfg.cacheTtl}`,
      },
    });
  } catch (error) {
    log(cfg, `Error: ${error.message}`);
    const status = error.status || 500;
    return jsonResponse({
      success: false,
      error: `代理处理错误: ${error.message}`,
      targetUrl,
    }, status);
  }
}
