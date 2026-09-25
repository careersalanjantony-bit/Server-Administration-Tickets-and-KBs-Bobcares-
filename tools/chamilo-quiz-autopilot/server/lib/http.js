'use strict';

const crypto = require('crypto');

// The extension calls this API from moz-extension:// pages and quiz pages.
// Requests carry the access key in a header (no cookies), so any origin is fine.
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// Vercel parses JSON bodies into req.body; a plain Node server does not.
async function readJson(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4 * 1024 * 1024) throw new Error('Request too large');
  }
  return raw ? JSON.parse(raw) : {};
}

// "Authorization: Bearer <BANK_TOKEN>", compared in constant time.
function authorized(req) {
  const want = process.env.BANK_TOKEN || '';
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!want || !got) return false;
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(want), h(got));
}

function query(req) {
  return new URL(req.url, 'http://localhost').searchParams;
}

module.exports = { cors, send, readJson, authorized, query };
