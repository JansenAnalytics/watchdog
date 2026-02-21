#!/usr/bin/env node
/**
 * watchdog — monitors Kite's own jobs and services for health
 *
 * Checks:
 *   cron_jobs    — verifies each cron job ran recently (reads its log)
 *   processes    — verifies registered PIDs/process names are alive
 *   disk         — alerts if disk usage exceeds threshold
 *   log_errors   — scans logs for recent ERROR/FATAL lines
 *   http_checks  — verifies HTTP endpoints return 2xx
 *
 * Alert cooldown: 2h per check to avoid spam
 * Cron: every 30 minutes
 */

'use strict';

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const { execSync } = require('child_process');
const { URL }  = require('url');

const DIR         = __dirname;
const CONFIG_FILE = path.join(DIR, 'config.json');
const STATE_FILE  = path.join(DIR, 'state.json');
const LOG_FILE    = path.join(DIR, 'watchdog.log');
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

// ── Helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function loadJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function inCooldown(state, id) {
  const last = state[id]?.lastAlertedAt;
  if (!last) return false;
  return Date.now() - new Date(last).getTime() < COOLDOWN_MS;
}

function markAlerted(state, id) {
  state[id] = { ...(state[id] || {}), lastAlertedAt: new Date().toISOString() };
}

// ── Notifiers ──────────────────────────────────────────────────────────────

function sendTelegram(botToken, chatId, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => JSON.parse(d).ok ? resolve() : reject(new Error(d.slice(0, 200))));
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

function sendNtfy(server, topic, { title, message, priority = 4, tags = '' }) {
  return new Promise((resolve, reject) => {
    const body    = Buffer.from(message, 'utf8');
    const url     = new URL(`${server.replace(/\/$/, '')}/${topic}`);
    const lib     = url.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
      'Title':    title,
      'Priority': String(priority),
    };
    if (tags) headers['Tags'] = tags;
    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => res.statusCode < 300 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`)));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function alert(config, alertState, id, title, message) {
  if (inCooldown(alertState, id)) {
    log(`  [cooldown] Skipping alert for ${id} (within 2h cooldown)`);
    return;
  }

  log(`  🚨 ALERT: ${title} — ${message}`);

  try {
    const ocConfig = JSON.parse(fs.readFileSync('/home/ajans/.openclaw/openclaw.json', 'utf8'));
    const botToken = ocConfig.channels?.telegram?.botToken;
    if (botToken && config.telegram?.chatId) {
      await sendTelegram(botToken, config.telegram.chatId,
        `🚨 <b>Watchdog: ${title}</b>\n\n${message}`);
      log(`  ✅ Telegram alerted`);
    }
  } catch (e) { log(`  WARN Telegram: ${e.message}`); }

  if (config.ntfy?.topic) {
    try {
      await sendNtfy(config.ntfy.server || 'https://ntfy.sh', config.ntfy.topic, {
        title: `Watchdog: ${title}`,
        message,
        priority: 5,
        tags: 'rotating_light,warning',
      });
      log(`  ✅ ntfy alerted`);
    } catch (e) { log(`  WARN ntfy: ${e.message}`); }
  }

  markAlerted(alertState, id);
}

// ── Checks ─────────────────────────────────────────────────────────────────

async function checkCronJob(config, alertState, job) {
  log(`[cron_job] ${job.name}`);
  if (!fs.existsSync(job.log)) {
    await alert(config, alertState, `cron:${job.id}`, `Cron job missing log`, `${job.name}: log file not found at ${job.log}`);
    return;
  }

  const stat    = fs.statSync(job.log);
  const ageMins = (Date.now() - stat.mtimeMs) / 60000;
  const maxMins = job.max_silence_minutes || 30;

  if (ageMins > maxMins) {
    await alert(config, alertState, `cron:${job.id}`,
      `Cron job silent`, `${job.name} hasn't run in ${Math.round(ageMins)} minutes (max: ${maxMins})`);
  } else {
    log(`  OK — last ran ${Math.round(ageMins)} min ago`);
  }
}

async function checkProcess(config, alertState, proc) {
  log(`[process] ${proc.name}`);
  let alive = false;

  if (proc.pid_file) {
    try {
      const pid = parseInt(fs.readFileSync(proc.pid_file, 'utf8').trim(), 10);
      try { process.kill(pid, 0); alive = true; } catch {}
    } catch {}
  } else if (proc.process_name) {
    try {
      execSync(`pgrep -f "${proc.process_name}"`, { stdio: 'ignore' });
      alive = true;
    } catch {}
  }

  if (!alive) {
    await alert(config, alertState, `proc:${proc.id}`,
      `Process down`, `${proc.name} is not running`);
  } else {
    log(`  OK — running`);
  }
}

async function checkDisk(config, alertState, disk) {
  log(`[disk] ${disk.path}`);
  try {
    const out = execSync(`df -h "${disk.path}" | tail -1`, { encoding: 'utf8' });
    const cols = out.trim().split(/\s+/);
    const usePct = parseInt(cols[4], 10);
    const threshold = disk.alert_above_percent || 85;
    log(`  Usage: ${usePct}% (alert above ${threshold}%)`);
    if (usePct >= threshold) {
      await alert(config, alertState, `disk:${disk.path}`,
        `Disk usage high`, `${disk.path} is ${usePct}% full (threshold: ${threshold}%)`);
    }
  } catch (e) {
    log(`  ERROR: ${e.message}`);
  }
}

async function checkLogErrors(config, alertState, logCheck) {
  log(`[log_errors] ${logCheck.id}`);
  if (!fs.existsSync(logCheck.log)) {
    log(`  Log not found: ${logCheck.log}`);
    return;
  }

  const lookbackMs  = (logCheck.lookback_minutes || 60) * 60 * 1000;
  const cutoff      = Date.now() - lookbackMs;
  const content     = fs.readFileSync(logCheck.log, 'utf8');
  const errorLines  = content.split('\n').filter(line => {
    const match = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.Z]+)\]/);
    if (!match) return false;
    const ts = new Date(match[1]).getTime();
    return ts > cutoff && /ERROR|FATAL|CRIT/i.test(line);
  });

  if (errorLines.length > 0) {
    const sample = errorLines.slice(-3).join('\n');
    await alert(config, alertState, `log:${logCheck.id}`,
      `Errors in ${logCheck.id}`, `${errorLines.length} error(s) in last ${logCheck.lookback_minutes || 60}min:\n${sample}`);
  } else {
    log(`  OK — no errors in last ${logCheck.lookback_minutes || 60} min`);
  }
}

async function checkHttp(config, alertState, endpoint) {
  log(`[http] ${endpoint.url}`);
  return new Promise((resolve) => {
    const parsed = new URL(endpoint.url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(endpoint.url, { timeout: 10000 }, async (res) => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      log(`  HTTP ${res.statusCode} — ${ok ? 'OK' : 'FAIL'}`);
      if (!ok) {
        await alert(config, alertState, `http:${endpoint.id}`,
          `HTTP check failed`, `${endpoint.url} returned ${res.statusCode}`);
      }
      res.resume();
      resolve();
    });
    req.on('error', async (e) => {
      log(`  ERROR: ${e.message}`);
      await alert(config, alertState, `http:${endpoint.id}`,
        `HTTP check error`, `${endpoint.url} unreachable: ${e.message}`);
      resolve();
    });
    req.on('timeout', async () => {
      req.destroy();
      log(`  TIMEOUT`);
      await alert(config, alertState, `http:${endpoint.id}`,
        `HTTP check timeout`, `${endpoint.url} timed out`);
      resolve();
    });
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const config     = loadJson(CONFIG_FILE);
  const alertState = loadJson(STATE_FILE, {});

  for (const job      of config.cron_jobs   || []) await checkCronJob(config, alertState, job);
  for (const proc     of config.processes   || []) await checkProcess(config, alertState, proc);
  for (const disk     of config.disk        || []) await checkDisk(config, alertState, disk);
  for (const logCheck of config.log_errors  || []) await checkLogErrors(config, alertState, logCheck);
  for (const endpoint of config.http_checks || []) await checkHttp(config, alertState, endpoint);

  saveJson(STATE_FILE, alertState);
  log('Done.');
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
