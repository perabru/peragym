import qrcode from 'qrcode-generator';
import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_BASE = '/peragym/docs/';
const TEXT_TYPES = new Set(['.html', '.css', '.js', '.webmanifest', '.json', '.svg', '.txt']);
const BINARY_TYPES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ttf', '.woff', '.woff2']);
const FILE_PATHS = new Set(['/app', '/download', '/index.html', '/offline.html', '/manifest.webmanifest', '/pwa.js', '/pwa.css', '/promo.js', '/promo.css', '/sw.js']);
const DIRECTORY_PATHS = ['/app/', '/assets/', '/icons/'];
const PIX_KEY = 'bruno.pera@unifesp.br';

export function normalizeBasePath(value = DEFAULT_BASE) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('//') || /[?#%\\\s]/.test(value)
      || value.split('/').some(part => part === '.' || part === '..') || !/^\/[A-Za-z0-9_./-]*$/.test(value)) {
    throw new Error('The Pages base path must be a plain absolute directory, such as /peragym/docs/.');
  }
  return value.endsWith('/') ? value : value + '/';
}

function publicUrl(value, base, includeRoot = false) {
  if (includeRoot && value === '/') return base;
  const pathname = value.split(/[?#]/, 1)[0];
  if (pathname === '/api/donation') return base + 'donation.json' + value.slice(pathname.length);
  if (FILE_PATHS.has(pathname) || DIRECTORY_PATHS.some(prefix => value.startsWith(prefix))) return base + value.slice(1);
  return value;
}

function htmlUrls(source, base) {
  return source.replace(/(\b(?:href|src|action|poster)\s*[$*^~|]?=\s*)(["'])(\/[^"'\s<>]*)\2/gi,
    (_, prefix, quote, value) => prefix + quote + publicUrl(value, base, true) + quote);
}

function cssUrls(source, base) {
  return source.replace(/(url\(\s*)(["']?)(\/[^\s)'"<>]+)\2(\s*\))/gi,
    (_, prefix, quote, value, suffix) => prefix + quote + publicUrl(value, base) + quote + suffix);
}

// Walk JavaScript literals instead of replacing slash characters globally. In
// particular, YouTube URL parsing, division operators, comments and RegExp
// literals must remain unchanged. HTML attributes inside template strings are
// adapted, and ${...} expressions are walked recursively.
function javascriptUrls(source, base) {
  let position = 0;
  function walk(inExpression = false) {
    let output = '', braces = 0, expressionStart = true;
    while (position < source.length) {
      const character = source[position], next = source[position + 1];
      if (inExpression && character === '}' && braces === 0) { position++; return output; }
      if (character === '/' && next === '/') {
        const end = source.indexOf('\n', position);
        const stop = end === -1 ? source.length : end;
        output += source.slice(position, stop); position = stop; continue;
      }
      if (character === '/' && next === '*') {
        const end = source.indexOf('*/', position + 2);
        if (end === -1) throw new Error('Unterminated JavaScript comment.');
        output += source.slice(position, end + 2); position = end + 2; continue;
      }
      if (character === '"' || character === "'") {
        const quote = character; let body = ''; position++;
        while (position < source.length && source[position] !== quote) {
          if (source[position] === '\\') { body += source.slice(position, position + 2); position += 2; }
          else body += source[position++];
        }
        if (position >= source.length) throw new Error('Unterminated JavaScript string.');
        position++;
        output += quote + cssUrls(htmlUrls(publicUrl(body, base), base), base) + quote;
        expressionStart = false; continue;
      }
      if (character === '`') {
        output += '`'; position++; let body = '', closed = false;
        while (position < source.length) {
          if (source[position] === '\\') { body += source.slice(position, position + 2); position += 2; }
          else if (source[position] === '`') { output += cssUrls(htmlUrls(body, base), base) + '`'; position++; closed = true; break; }
          else if (source[position] === '$' && source[position + 1] === '{') {
            output += cssUrls(htmlUrls(body, base), base) + '${'; body = ''; position += 2;
            output += walk(true) + '}';
          } else body += source[position++];
        }
        if (!closed) throw new Error('Unterminated JavaScript template.');
        expressionStart = false; continue;
      }
      if (character === '/' && expressionStart) {
        const start = position++; let bracket = false, closed = false;
        while (position < source.length) {
          const item = source[position++];
          if (item === '\\') { position++; continue; }
          if (item === '[') bracket = true;
          else if (item === ']') bracket = false;
          else if (item === '/' && !bracket) { closed = true; break; }
          if (item === '\n') break;
        }
        if (!closed) throw new Error('Unterminated JavaScript regular expression.');
        while (/[A-Za-z]/.test(source[position] || '') && position < source.length) position++;
        output += source.slice(start, position); expressionStart = false; continue;
      }
      if (/[A-Za-z_$]/.test(character)) {
        const start = position++;
        while (position < source.length && /[\w$]/.test(source[position])) position++;
        const word = source.slice(start, position); output += word;
        expressionStart = /^(?:return|throw|yield|case|delete|void|typeof|new|in|of|await|instanceof|else|do)$/.test(word); continue;
      }
      if (/[0-9]/.test(character)) {
        const start = position++;
        while (position < source.length && /[\w.]/.test(source[position])) position++;
        output += source.slice(start, position); expressionStart = false; continue;
      }
      if (character === '{') braces++;
      else if (character === '}') braces--;
      if (!/\s/.test(character)) expressionStart = !/[\])}.]/.test(character);
      output += character; position++;
    }
    if (inExpression) throw new Error('Unterminated JavaScript template expression.');
    return output;
  }
  return walk();
}

export function rewritePublicText(source, relativePath, basePath = DEFAULT_BASE) {
  const base = normalizeBasePath(basePath), extension = path.extname(relativePath);
  if (extension === '.html') {
    return htmlUrls(source, base).replace(/<head(?:\s[^>]*)?>/i, match => match + '\n  <meta name="peragym-static" content="1">');
  }
  if (extension === '.css') return cssUrls(source, base);
  if (extension !== '.js') return source;
  // OAuth compares the application's pathname with /index.html. It has no
  // public asset URLs and must remain identical across publishing bases.
  if (relativePath === 'app/spotify-account.js') return source;
  let result = javascriptUrls(source, base);
  if (relativePath === 'pwa.js') {
    result = result.replace(/(\bscope\s*:\s*)(["'])\/\2/g, (_, prefix, quote) => prefix + quote + base + quote);
  }
  if (relativePath === 'sw.js') {
    result = result.replace(/(const PUBLIC_PATHS\s*=\s*new Set\(\[\s*)(["'])\/\2/, (_, prefix, quote) => prefix + quote + base + quote);
    const namespace = 'peragym-pages-' + createHash('sha256').update(base).digest('hex').slice(0, 12) + '-';
    result = result.replace(/(const VERSION\s*=\s*)(["'])peragym-([^"']+)\2/, (_, prefix, quote, version) => prefix + quote + namespace + version + quote);
    result = result.replace(/(const CACHE_PREFIX\s*=\s*)(["'])peragym-\2/, (_, prefix, quote) => prefix + quote + namespace + quote);
  }
  return result;
}

function crc16(value) {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(value)) {
    crc ^= byte << 8;
    for (let index = 0; index < 8; index++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function createDonation(basePath = DEFAULT_BASE) {
  const base = normalizeBasePath(basePath);
  const field = (id, value) => id + String(Buffer.byteLength(value)).padStart(2, '0') + value;
  const account = field('00', 'br.gov.bcb.pix') + field('01', PIX_KEY);
  const payload = field('00', '01') + field('26', account) + field('52', '0000') + field('53', '986') + field('54', '1.99')
    + field('58', 'BR') + field('59', 'BRUNO MICHEL PERA') + field('60', 'BRASIL') + field('62', field('05', 'PERAGYMAPOIO')) + '6304';
  const pixPayload = payload + crc16(payload);
  const qr = qrcode(0, 'M'); qr.addData(pixPayload, 'Byte'); qr.make();
  return {amountCents: 199, pixKey: PIX_KEY, pixPayload,
    qrDataUrl: 'data:image/svg+xml;base64,' + Buffer.from(qr.createSvgTag({cellSize: 4, margin: 16, scalable: true})).toString('base64'),
    currency: 'BRL', optional: true, appUrl: base + 'app/', downloadUrl: base + 'download/'};
}

async function listFiles(directory, includeHidden = false) {
  const results = [];
  for (const item of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!includeHidden && item.name.startsWith('.')) continue;
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('Pages public files must not contain symlinks: ' + file);
    if (item.isDirectory()) results.push(...await listFiles(file, includeHidden));
    else if (item.isFile()) results.push(file);
  }
  return results;
}

const redirectHtml = (target, title = 'Abrir PeraGym') => `<!doctype html>\n<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0;url=${target}"><title>${title}</title><link rel="canonical" href="${target}"></head><body><a href="${target}">${title}</a></body></html>\n`;

export async function buildPages({projectRoot = PROJECT_ROOT, outputDir = '../docs', basePath = DEFAULT_BASE, check = false} = {}) {
  const root = path.resolve(projectRoot), web = path.join(root, 'web'), output = path.resolve(root, outputDir);
  const base = normalizeBasePath(basePath);
  if (output === path.parse(output).root || output === root || output === web || web.startsWith(output + path.sep) || output.startsWith(web + path.sep)) throw new Error('Pages output must not overlap its source directory.');
  const files = new Map();
  for (const file of await listFiles(web)) {
    const relative = path.relative(web, file).split(path.sep).join('/');
    if (/\.test\.|\.map$/.test(relative)) continue;
    const extension = path.extname(file);
    if (!TEXT_TYPES.has(extension) && !BINARY_TYPES.has(extension)) throw new Error('Unsupported public file: ' + relative);
    const bytes = await readFile(file);
    if (extension === '.webmanifest') {
      const manifest = JSON.parse(bytes.toString('utf8'));
      manifest.id = base + 'app/'; manifest.start_url = base + 'app/'; manifest.scope = base;
      manifest.icons = manifest.icons.map(icon => ({...icon, src: publicUrl(icon.src, base)}));
      files.set(relative, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    } else files.set(relative, TEXT_TYPES.has(extension) ? Buffer.from(rewritePublicText(bytes.toString('utf8'), relative, base)) : bytes);
  }
  files.set('donation.json', Buffer.from(JSON.stringify(createDonation(base)) + '\n'));
  files.set('download/index.html', Buffer.from(redirectHtml(base + 'app/?instalar=1', 'Instalar PeraGym')));
  files.set('.nojekyll', Buffer.alloc(0));

  // The existing repository publishes its root. Keep that Pages setting and
  // place the browser app in docs/, separate from the older Android app/ tree.
  const rootFiles = new Map();
  if (output === path.resolve(root, '../docs')) {
    rootFiles.set(path.resolve(root, '../index.html'), Buffer.from(redirectHtml('./docs/')));
    rootFiles.set(path.resolve(root, '../.nojekyll'), Buffer.alloc(0));
  }
  if (check) {
    const differences = [];
    let existing = [];
    try { existing = await listFiles(output, true); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const [relative, expected] of files) {
      try { if (!expected.equals(await readFile(path.join(output, relative)))) differences.push(relative); }
      catch (error) { if (error.code !== 'ENOENT') throw error; differences.push(relative); }
    }
    for (const file of existing) {
      const relative = path.relative(output, file).split(path.sep).join('/');
      if (!files.has(relative)) differences.push(relative + ' (unexpected)');
    }
    for (const [file, expected] of rootFiles) {
      try { if (!expected.equals(await readFile(file))) differences.push(path.relative(root, file)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; differences.push(path.relative(root, file)); }
    }
    if (differences.length) throw new Error('Pages output is stale. Run npm run build:pages. Differences: ' + differences.join(', '));
  } else {
    await rm(output, {recursive: true, force: true});
    for (const [relative, bytes] of files) { const file = path.join(output, relative); await mkdir(path.dirname(file), {recursive: true}); await writeFile(file, bytes); }
    for (const [file, bytes] of rootFiles) await writeFile(file, bytes);
  }
  return {outputDir: output, basePath: base, files: [...files.keys()], checked: check};
}

async function main() {
  const options = {};
  const argumentsList = process.argv.slice(2);
  while (argumentsList.length) {
    const argument = argumentsList.shift();
    if (argument === '--check') options.check = true;
    else if (argument === '--base-path') {
      if (!argumentsList.length || argumentsList[0].startsWith('--')) throw new Error('Missing value for ' + argument);
      options.basePath = argumentsList.shift();
    }
    else if (argument === '--output') {
      if (!argumentsList.length || argumentsList[0].startsWith('--')) throw new Error('Missing value for ' + argument);
      options.outputDir = argumentsList.shift();
    }
    else throw new Error('Unknown Pages build argument: ' + argument);
  }
  const result = await buildPages(options);
  console.log(`${result.checked ? 'Verified' : 'Built'} ${result.files.length} static Pages files at ${result.outputDir} (base ${result.basePath}).`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
