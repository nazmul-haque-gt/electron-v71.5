'use strict';
// Replacement for serve.ps1's image proxy route: downloads a picture that lives on another website
// (a browser page may not read it because of CORS; this process can, like Word does when you paste
// web content). Same rules as before: http(s) only, public addresses only (checked on every redirect
// hop AND at connect time), max 6 redirects, 15 s timeouts, must be image/*, max 15 MB.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_HOPS = 6;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function isPrivateAddress(addr) {
  if (!addr) return true;
  let a = addr;
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);        // IPv4-mapped IPv6
  if (m) a = m[1];
  if (net.isIPv4(a)) {
    const p = a.split('.').map(Number);
    if (p[0] === 10 || p[0] === 0 || p[0] === 127) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if (p[0] >= 224) return true;                             // multicast / reserved
    return false;
  }
  if (net.isIPv6(a)) {
    const l = a.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (/^fe[89ab]/.test(l)) return true;                     // link-local
    if (/^fe[c-f]/.test(l)) return true;                      // site-local
    if (/^f[cd]/.test(l)) return true;                        // unique local
    return false;
  }
  return true;
}

// Used as the `lookup` option, so the address that is actually connected to is the one that was checked.
function makeLookup(allowPrivate) {
  return function (hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, Object.assign({}, options, { all: true }), function (err, addrs) {
      if (err) return cb(err);
      if (!addrs || !addrs.length) return cb(new Error('no address'));
      if (!allowPrivate) {
        for (const a of addrs) { if (isPrivateAddress(a.address)) return cb(new Error('address not allowed')); }
      }
      if (options && options.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

function getOnce(url, allowPrivate) {
  return new Promise(function (resolve, reject) {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET',
      lookup: makeLookup(allowPrivate),
      timeout: 15000,
      headers: {
        'User-Agent': UA,
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': url.protocol + '//' + url.host + '/'
      }
    }, resolve);
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// Returns { type, bytes }. Throws Error(reason) on any failure.
async function fetchImage(target, opts) {
  const allowPrivate = !!(opts && opts.allowPrivate);   // only the tests turn this on
  if (typeof target !== 'string' || !target || target.length > 4000) throw new Error('no url');
  let url;
  try { url = new URL(target); } catch (_) { throw new Error('bad url'); }
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('address not allowed');
    const bare = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(bare) && isPrivateAddress(bare)) throw new Error('address not allowed');
    const res = await getOnce(url, allowPrivate);
    const code = res.statusCode;
    if (code >= 300 && code < 400) {
      res.resume();
      const loc = res.headers.location;
      if (!loc) throw new Error('redirect without location');
      try { url = new URL(loc, url); } catch (_) { throw new Error('bad redirect'); }
      continue;
    }
    if (code !== 200) { res.resume(); throw new Error('remote status ' + code); }
    const ctype = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!ctype.startsWith('image/')) { res.resume(); throw new Error('not an image'); }
    const len = parseInt(res.headers['content-length'] || '0', 10);
    if (len > MAX_BYTES) { res.resume(); throw new Error('image too large'); }
    const chunks = []; let total = 0; let tooBig = false;
    await new Promise(function (resolve, reject) {
      res.setTimeout(15000, function () { res.destroy(new Error('timeout')); });
      res.on('data', function (c) {
        total += c.length;
        if (total > MAX_BYTES) { tooBig = true; reject(new Error('image too large')); res.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', resolve);
      res.on('error', function (e) { reject(tooBig ? new Error('image too large') : e); });
      res.on('aborted', function () { reject(tooBig ? new Error('image too large') : new Error('aborted')); });
    });
    return { type: ctype, bytes: Buffer.concat(chunks) };
  }
  throw new Error('too many redirects');
}

module.exports = { fetchImage, isPrivateAddress };
