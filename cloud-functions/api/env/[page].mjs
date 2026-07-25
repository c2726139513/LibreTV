// /cloud-functions/api/env/[page].mjs
// EdgeOne Cloud Function: Inject environment variables into HTML pages
// Rewrites from edgeone.json route /, /index.html, /player.html, /s=* to this function

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Compute SHA-256 hex digest (same as other platforms)
 */
function sha256Hash(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Read and inject env vars into an HTML file
 */
function renderPage(filePath, password) {
  let content = fs.readFileSync(filePath, 'utf8');
  if (password) {
    const hash = sha256Hash(password);
    content = content.replace('{{PASSWORD}}', hash);
  } else {
    content = content.replace('{{PASSWORD}}', '');
  }
  return content;
}

/**
 * EdgeOne Cloud Function Handler
 */
export default async function onRequest(context) {
  const { request, env, params } = context;
  const page = params.page; // 'index' or 'player' — from dynamic route [page]

  // Determine which HTML file to serve
  const projectRoot = process.cwd();
  let htmlFile;
  if (page === 'player') {
    htmlFile = path.join(projectRoot, 'player.html');
  } else {
    htmlFile = path.join(projectRoot, 'index.html');
  }

  try {
    const password = env.PASSWORD || '';
    const html = renderPage(htmlFile, password);

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  } catch (error) {
    console.error('Error serving HTML page:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
