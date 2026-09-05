#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { chromium } = require('playwright');

const ORIGIN = 'https://xsite.singaporetech.edu.sg';
const LE_VERSIONS = ['1.75', '1.74', '1.73', '1.72', '1.71', '1.70'];
const LP_VERSIONS = ['1.47', '1.46', '1.45', '1.44', '1.43', '1.42'];

function usage() {
  return `xsite weekly downloader

Usage:
  node download-xsite.js --list-courses --headed
  node download-xsite.js --config xsite-courses.json
  node download-xsite.js --course-url https://xsite.singaporetech.edu.sg/d2l/home/123456 --course-code INFXXXX

Options:
  --config PATH             JSON config with courses (default: ./xsite-courses.json)
  --download-dir PATH       Override config downloadDir
  --env-file PATH           Optional env file with XSITE_USERNAME/XSITE_PASSWORD (default: ./.env)
  --auth-file PATH          Browser session file (default: ./.auth/xsite-storage-state.json)
  --list-courses            Print accessible xSiTe courses and exit
  --course-url URL          Download one course without a config file
  --course-code CODE        Folder/code for --course-url
  --include REGEX           Add include filter matched against "Module / Week / Topic"
  --exclude REGEX           Add exclude filter
  --dry-run                 Show what would download; write nothing
  --force                   Redownload even when manifest says current
  --headed                  Show browser during automated login
  --interactive-login       Open browser and let you log in manually
  --chrome                  Use installed Google Chrome instead of Playwright Chromium
  --fresh-login             Ignore saved browser session
  --save-session            Save browser cookies for later runs
  --no-logout               Do not actively log out at the end (needed with --save-session)
  --logout                  Actively log out at the end (default)
  --verbose                 Show filtered/current skips
  -h, --help                Show this help

Credentials are read from environment/.env or prompted. They are never written into this script.
`;
}

function parseArgs(argv) {
  const args = {
    config: null,
    downloadDir: null,
    envFile: '.env',
    authFile: path.join('.auth', 'xsite-storage-state.json'),
    listCourses: false,
    courseUrl: null,
    courseCode: null,
    include: [],
    exclude: [],
    dryRun: false,
    force: false,
    headed: false,
    interactiveLogin: false,
    chrome: false,
    freshLogin: false,
    saveSession: false,
    logout: true,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--config') args.config = next();
    else if (a === '--download-dir') args.downloadDir = next();
    else if (a === '--env-file') args.envFile = next();
    else if (a === '--auth-file') args.authFile = next();
    else if (a === '--list-courses') args.listCourses = true;
    else if (a === '--course-url') args.courseUrl = next();
    else if (a === '--course-code') args.courseCode = next();
    else if (a === '--include') args.include.push(next());
    else if (a === '--exclude') args.exclude.push(next());
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--headed') args.headed = true;
    else if (a === '--headless') args.headed = false;
    else if (a === '--interactive-login') args.interactiveLogin = true;
    else if (a === '--chrome') args.chrome = true;
    else if (a === '--fresh-login') args.freshLogin = true;
    else if (a === '--save-session') args.saveSession = true;
    else if (a === '--no-logout') args.logout = false;
    else if (a === '--logout') args.logout = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function expandPath(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

function loadEnvFile(file) {
  const out = {};
  const resolved = expandPath(file);
  if (!resolved || !fs.existsSync(resolved)) return out;
  const text = fs.readFileSync(resolved, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function askLine(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('No TTY available for password prompt; use XSITE_PASSWORD or --interactive-login.'));
    const stdin = process.stdin;
    const stdout = process.stdout;
    let value = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
    };
    const onData = (buf) => {
      const ch = String(buf);
      if (ch === '\u0003') {
        cleanup();
        reject(new Error('Cancelled'));
      } else if (ch === '\r' || ch === '\n') {
        cleanup();
        resolve(value);
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

async function getCredentials(args, allowPrompt) {
  const env = { ...loadEnvFile(args.envFile), ...process.env };
  let username = env.XSITE_USERNAME || '';
  let password = env.XSITE_PASSWORD || '';
  if (allowPrompt && !args.interactiveLogin) {
    if (!username) username = await askLine('xSiTe username/email: ');
    if (!password) password = await askHidden('xSiTe password: ');
  }
  return { username, password };
}

function parseCourseId(input) {
  const raw = String(input || '');
  const m = raw.match(/\/d2l\/home\/(\d+)/) || raw.match(/\b(\d{4,})\b/);
  if (!m) throw new Error(`Could not find a Brightspace course id in: ${input}`);
  return m[1];
}

function courseHome(course) {
  if (course.homeUrl) return course.homeUrl;
  if (course.id) return `${ORIGIN}/d2l/home/${course.id}`;
  throw new Error(`Course entry needs homeUrl or id: ${JSON.stringify(course)}`);
}

async function loadConfig(args) {
  if (args.courseUrl) {
    return {
      downloadDir: args.downloadDir || './xsite-downloads',
      includePathRegex: args.include,
      excludePathRegex: args.exclude,
      courses: [{ code: args.courseCode || `course-${parseCourseId(args.courseUrl)}`, homeUrl: args.courseUrl }],
    };
  }
  const configPath = expandPath(args.config || 'xsite-courses.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config: ${configPath}\nRun --list-courses, then copy xsite-courses.example.json to xsite-courses.json and fill course URLs.`);
  }
  const config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  config.__path = configPath;
  return config;
}

function compileRegexes(values, label) {
  const flat = (values || []).flat().filter(Boolean);
  return flat.map((v) => {
    try { return new RegExp(v, 'i'); }
    catch (err) { throw new Error(`Invalid ${label} regex ${JSON.stringify(v)}: ${err.message}`); }
  });
}

function sanitizeSegment(s) {
  return String(s || 'untitled')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120) || 'untitled';
}

function absUrl(raw) {
  if (!raw) return null;
  if (/^d2l:/i.test(raw)) return null;
  return new URL(raw, ORIGIN).toString();
}

function extFromUrl(raw) {
  try {
    const u = new URL(raw, ORIGIN);
    const decoded = decodeURIComponent(u.pathname);
    const ext = path.extname(decoded).replace(/[^.A-Za-z0-9_-]/g, '');
    if (ext && ext.length <= 12) return ext;
  } catch {}
  return '';
}

function filenameForTopic(topic) {
  const title = sanitizeSegment(topic.Title || `topic-${topic.Id}`);
  const ext = extFromUrl(topic.Url || '');
  if (ext && title.toLowerCase().endsWith(ext.toLowerCase())) return title;
  return title + ext;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function clickText(page, patterns, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate((patterns) => {
      const pats = patterns.map((p) => new RegExp(p, 'i'));
      const candidates = [...document.querySelectorAll('button, a, input[type=submit], input[type=button]')];
      for (const el of candidates) {
        const text = [el.innerText, el.textContent, el.value, el.getAttribute('aria-label'), el.title]
          .filter(Boolean).join(' ').trim();
        if (pats.some((p) => p.test(text))) {
          el.click();
          return text || el.tagName;
        }
      }
      return null;
    }, patterns).catch(() => null);
    if (clicked) return clicked;
    await page.waitForTimeout(500);
  }
  return null;
}

async function typeFirst(page, selectors, value, label) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      const visible = await loc.isVisible({ timeout: 1000 }).catch(() => false);
      if (!visible) continue;
      await loc.click({ clickCount: 3 }).catch(() => null);
      await loc.fill(value, { timeout: 10000 }).catch(async () => {
        await loc.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => null);
        await loc.type(value, { delay: 5 });
      });
      return sel;
    }
  }
  throw new Error(`Could not find ${label} field`);
}

async function isLoggedIntoXsite(page) {
  const url = page.url();
  if (!url.includes('xsite.singaporetech.edu.sg') || !url.includes('/d2l/')) return false;
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const title = await page.title().catch(() => '');
  if (/SIT Login|Sign in to your account|Enter password|loginfmt|Forgot my password/i.test(text + ' ' + title)) return false;
  return /Course Home|Content|Announcements|Brightspace|xSiTe|Navbar|Log Out|Logout/i.test(text + ' ' + title);
}

async function automatedLogin(page, startUrl, username, password) {
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
  const saml = await page.$('#samlLinkId');
  if (saml) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null),
      saml.click(),
    ]);
  } else {
    await clickText(page, ['^SIT Login$', '^Log in$', '^Login$', '^Sign in$'], 12000);
  }
  await page.waitForTimeout(1200);
  await typeFirst(page, [
    'input[type="email"]', 'input[name="loginfmt"]', 'input[name="username"]',
    'input[name="userName"]', 'input[name="j_username"]', 'input[type="text"]',
  ], username, 'username');
  await clickText(page, ['Next', 'Submit', 'Continue', 'Sign in', 'Log in'], 10000).catch(() => null);
  await page.keyboard.press('Enter').catch(() => null);
  await page.waitForTimeout(2000);
  await typeFirst(page, [
    'input[type="password"]', 'input[name="passwd"]', 'input[name="password"]', 'input[name="j_password"]',
  ], password, 'password');
  await clickText(page, ['Sign in', 'Log in', 'Login', 'Submit'], 10000).catch(() => null);
  await page.keyboard.press('Enter').catch(() => null);
  await page.waitForTimeout(4000);
  await clickText(page, ['^No$', '^Yes$'], 4000).catch(() => null);
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => null);
}

async function ensureLoggedIn(page, args, startUrl, hasSavedState) {
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
  if (await isLoggedIntoXsite(page)) return;

  if (args.interactiveLogin) {
    if (await page.$('#samlLinkId')) await clickText(page, ['^SIT Login$'], 5000).catch(() => null);
    console.log('Complete xSiTe/SIT login in the opened browser, then press Enter here.');
    await askLine('Press Enter after xSiTe has loaded: ');
    if (!(await isLoggedIntoXsite(page))) throw new Error('Still not logged into xSiTe after manual login.');
    return;
  }

  const creds = await getCredentials(args, true);
  if (!creds.username || !creds.password) {
    if (hasSavedState) throw new Error('Saved session is expired. Re-run with --interactive-login or provide credentials.');
    throw new Error('Missing xSiTe credentials. Use .env, environment variables, or --interactive-login.');
  }
  await automatedLogin(page, startUrl, creds.username, creds.password);
  if (!(await isLoggedIntoXsite(page))) throw new Error('Login did not reach xSiTe. Try --headed or --interactive-login.');
}

async function apiGetJson(context, apiPath) {
  const url = new URL(apiPath, ORIGIN).toString();
  const res = await context.request.get(url, { headers: { accept: 'application/json' }, timeout: 60000 });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${apiPath} -> HTTP ${res.status()} ${res.statusText()}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function tryApiJson(context, apiPath) {
  const url = new URL(apiPath, ORIGIN).toString();
  const res = await context.request.get(url, { headers: { accept: 'application/json' }, timeout: 60000 });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { ok: res.ok(), status: res.status(), text, data };
}

async function pickLeVersion(context, courseId) {
  for (const v of LE_VERSIONS) {
    const res = await tryApiJson(context, `/d2l/api/le/${v}/${courseId}/content/root/`);
    if (res.ok && Array.isArray(res.data)) return v;
  }
  throw new Error(`Could not find a working Brightspace LE API version for course ${courseId}.`);
}

async function pickLpVersion(context) {
  for (const v of LP_VERSIONS) {
    const res = await tryApiJson(context, `/d2l/api/lp/${v}/enrollments/myenrollments/`);
    if (res.ok && res.data && Array.isArray(res.data.Items)) return v;
  }
  throw new Error('Could not find a working Brightspace LP API version for enrollments.');
}

async function listCourses(context) {
  const v = await pickLpVersion(context);
  const out = [];
  let bookmark = null;
  do {
    const qs = bookmark ? `?bookmark=${encodeURIComponent(bookmark)}` : '';
    const data = await apiGetJson(context, `/d2l/api/lp/${v}/enrollments/myenrollments/${qs}`);
    for (const item of data.Items || []) {
      const org = item.OrgUnit || {};
      const access = item.Access || {};
      if (org.Type?.Code === 'Course Offering' && access.CanAccess !== false && access.IsActive !== false) {
        out.push({ id: org.Id, code: org.Code, name: org.Name, homeUrl: org.HomeUrl });
      }
    }
    bookmark = data.PagingInfo?.HasMoreItems ? data.PagingInfo.Bookmark : null;
  } while (bookmark);
  return out;
}

async function collectTopics(context, leVersion, courseId) {
  const root = await apiGetJson(context, `/d2l/api/le/${leVersion}/${courseId}/content/root/`);
  const topics = [];
  const visitedModules = new Set();

  async function visitModule(moduleSummary, parentPath) {
    if (!moduleSummary || visitedModules.has(moduleSummary.Id)) return;
    visitedModules.add(moduleSummary.Id);
    if (moduleSummary.IsHidden || moduleSummary.IsLocked) return;
    const modulePath = [...parentPath, moduleSummary.Title || `module-${moduleSummary.Id}`];
    const children = await apiGetJson(context, `/d2l/api/le/${leVersion}/${courseId}/content/modules/${moduleSummary.Id}/structure/`);
    for (const child of children || []) {
      if (child.Type === 0) await visitModule(child, modulePath);
      else if (child.Type === 1) topics.push({ topic: child, pathParts: modulePath });
    }
  }

  for (const item of root || []) {
    if (item.Type === 0) await visitModule(item, []);
    else if (item.Type === 1) topics.push({ topic: item, pathParts: [] });
  }
  return topics;
}

async function loadManifest(downloadDir) {
  const manifestPath = path.join(downloadDir, '.xsite-manifest.json');
  if (!fs.existsSync(manifestPath)) return { version: 1, items: {} };
  try {
    const data = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    if (!data.items) data.items = {};
    return data;
  } catch {
    return { version: 1, items: {} };
  }
}

async function saveManifest(downloadDir, manifest, dryRun) {
  if (dryRun) return;
  await fsp.mkdir(downloadDir, { recursive: true });
  manifest.updatedAt = new Date().toISOString();
  const manifestPath = path.join(downloadDir, '.xsite-manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

function shouldInclude(fullPath, includeRegexes, excludeRegexes) {
  if (excludeRegexes.some((re) => re.test(fullPath))) return false;
  if (!includeRegexes.length) return true;
  return includeRegexes.some((re) => re.test(fullPath));
}

function topicPath(courseFolder, pathParts, topic) {
  const safeParts = [courseFolder, ...pathParts.map(sanitizeSegment)];
  return path.join(...safeParts, filenameForTopic(topic));
}

async function downloadTopic(context, downloadDir, manifest, course, courseId, item, options) {
  const { topic, pathParts } = item;
  const fullPath = [...pathParts, topic.Title || `topic-${topic.Id}`].join(' / ');
  const include = shouldInclude(fullPath, options.includeRegexes, options.excludeRegexes);
  if (!include) return { status: 'filtered', fullPath };
  if (topic.IsHidden || topic.IsLocked || topic.IsBroken) return { status: 'skipped-unavailable', fullPath };
  const absolute = absUrl(topic.Url || '');
  if (!absolute) return { status: 'skipped-unsupported', fullPath, reason: topic.Url ? 'non-downloadable Brightspace media/link' : 'missing URL' };

  const key = `${courseId}:${topic.Id}`;
  const courseFolder = sanitizeSegment(course.code || course.name || `course-${courseId}`);
  const relPath = manifest.items[key]?.path || topicPath(courseFolder, pathParts, topic);
  const finalPath = path.join(downloadDir, relPath);
  const relDisplay = path.relative(process.cwd(), finalPath).split(path.sep).join('/');
  const previous = manifest.items[key];

  if (!options.force && previous && previous.lastModifiedDate === topic.LastModifiedDate && fs.existsSync(finalPath)) {
    return { status: 'skipped-current', fullPath, relDisplay };
  }
  if (!options.force && !previous && fs.existsSync(finalPath)) {
    return { status: 'skipped-existing', fullPath, relDisplay };
  }
  if (options.dryRun) return { status: 'would-download', fullPath, relDisplay };

  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  const res = await context.request.get(absolute, { timeout: 180000 });
  if (!res.ok()) return { status: 'failed', fullPath, relDisplay, reason: `HTTP ${res.status()} ${res.statusText()}` };
  const contentType = res.headers()['content-type'] || '';
  const body = await res.body();
  if (!body.length) return { status: 'failed', fullPath, relDisplay, reason: 'empty response' };
  if (/text\/html/i.test(contentType) && !/\.html?$/i.test(finalPath)) {
    return { status: 'failed', fullPath, relDisplay, reason: `got HTML instead of a file (${contentType})` };
  }
  const tmp = `${finalPath}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, body);
  await fsp.rename(tmp, finalPath);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  manifest.items[key] = {
    courseId,
    courseCode: course.code || null,
    title: topic.Title || null,
    modulePath: pathParts,
    sourceUrl: topic.Url || null,
    lastModifiedDate: topic.LastModifiedDate || null,
    path: path.relative(downloadDir, finalPath).split(path.sep).join('/'),
    size: body.length,
    sha256,
    downloadedAt: new Date().toISOString(),
  };
  return { status: previous ? 'updated' : 'downloaded', fullPath, relDisplay, size: body.length, sha256 };
}

async function logout(page) {
  await page.goto(`${ORIGIN}/d2l/logout`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(1500);
  let text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  if (!/CLOSE YOUR BROWSER NOW|logged out|login|SIT Login/i.test(text)) {
    await clickText(page, ['Log Out', 'Logout'], 6000).catch(() => null);
    await page.waitForTimeout(1500);
    text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  }
  return /CLOSE YOUR BROWSER NOW|logged out|login|SIT Login/i.test(text);
}

async function runDownloads(context, config, args) {
  const downloadDir = expandPath(args.downloadDir || config.downloadDir || './xsite-downloads');
  const manifest = await loadManifest(downloadDir);
  const globalIncludes = [...(config.includePathRegex || []), ...args.include];
  const globalExcludes = [...(config.excludePathRegex || []), ...args.exclude];
  const totals = { downloaded: 0, updated: 0, would: 0, current: 0, existing: 0, filtered: 0, unsupported: 0, failed: 0, unavailable: 0, topics: 0 };

  for (const course of config.courses || []) {
    const home = courseHome(course);
    const courseId = parseCourseId(home);
    const label = course.code || course.name || `course-${courseId}`;
    const leVersion = await pickLeVersion(context, courseId);
    const includeRegexes = compileRegexes([globalIncludes, course.includePathRegex || []], 'includePathRegex');
    const excludeRegexes = compileRegexes([globalExcludes, course.excludePathRegex || []], 'excludePathRegex');
    const topics = await collectTopics(context, leVersion, courseId);
    console.log(`\n${label}: ${topics.length} content topics found (LE API ${leVersion})`);
    totals.topics += topics.length;

    for (const item of topics) {
      const result = await downloadTopic(context, downloadDir, manifest, course, courseId, item, {
        includeRegexes, excludeRegexes, dryRun: args.dryRun, force: args.force,
      });
      if (result.status === 'downloaded') {
        totals.downloaded++;
        console.log(`  downloaded ${result.relDisplay} (${formatBytes(result.size)})`);
      } else if (result.status === 'updated') {
        totals.updated++;
        console.log(`  updated    ${result.relDisplay} (${formatBytes(result.size)})`);
      } else if (result.status === 'would-download') {
        totals.would++;
        console.log(`  would      ${result.relDisplay}`);
      } else if (result.status === 'skipped-current') {
        totals.current++;
        if (args.verbose) console.log(`  current    ${result.relDisplay}`);
      } else if (result.status === 'skipped-existing') {
        totals.existing++;
        console.log(`  existing   ${result.relDisplay}`);
      } else if (result.status === 'filtered') {
        totals.filtered++;
        if (args.verbose) console.log(`  filtered   ${result.fullPath}`);
      } else if (result.status === 'skipped-unsupported') {
        totals.unsupported++;
        if (args.verbose || args.dryRun) console.log(`  unsupported ${result.fullPath} (${result.reason})`);
      } else if (result.status === 'skipped-unavailable') {
        totals.unavailable++;
        if (args.verbose) console.log(`  unavailable ${result.fullPath}`);
      } else if (result.status === 'failed') {
        totals.failed++;
        console.log(`  FAILED     ${result.fullPath}: ${result.reason}`);
      }
    }
  }
  await saveManifest(downloadDir, manifest, args.dryRun);
  return { downloadDir, totals };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const authFile = expandPath(args.authFile);
  const hasSavedState = !args.freshLogin && fs.existsSync(authFile);
  const config = args.listCourses ? null : await loadConfig(args);
  const firstUrl = args.listCourses
    ? `${ORIGIN}/d2l/home`
    : courseHome((config.courses || [])[0] || { homeUrl: `${ORIGIN}/d2l/home` });
  const headless = !(args.headed || args.interactiveLogin);
  const browserOptions = { headless };
  if (args.chrome) browserOptions.channel = 'chrome';

  const browser = await chromium.launch(browserOptions);
  const contextOptions = { acceptDownloads: true };
  if (hasSavedState) contextOptions.storageState = authFile;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    await ensureLoggedIn(page, args, firstUrl, hasSavedState);

    if (args.listCourses) {
      const courses = await listCourses(context);
      console.log('Accessible course offerings:');
      for (const c of courses) console.log(`${c.code || c.id} | ${c.name} | ${c.homeUrl}`);
      console.log(`Total: ${courses.length}`);
    } else {
      const { downloadDir, totals } = await runDownloads(context, config, args);
      console.log(`\nOutput: ${downloadDir}`);
      console.log(`Summary: downloaded=${totals.downloaded}, updated=${totals.updated}, would=${totals.would}, current=${totals.current}, existing=${totals.existing}, filtered=${totals.filtered}, unsupported=${totals.unsupported}, failed=${totals.failed}`);
      if (totals.failed) process.exitCode = 2;
    }

    if (args.saveSession && !args.logout) {
      await fsp.mkdir(path.dirname(authFile), { recursive: true });
      await context.storageState({ path: authFile });
      console.log(`Saved browser session: ${authFile}`);
    } else if (args.saveSession && args.logout) {
      console.log('Session not saved because --logout is active. Use --no-logout on a private laptop if you want saved cookies.');
    }

    if (args.logout) {
      const ok = await logout(page);
      console.log(ok ? 'Logged out.' : 'Logout attempted; please close the browser if it is still open.');
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
