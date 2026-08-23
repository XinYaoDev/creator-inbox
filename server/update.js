// 工作台自更新：不替换 .app。从 Git 远端或 GitHub Release 拉代码，构建 dist，重启 Node。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function parseVer(s) {
  const m = String(s || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpVer(a, b) {
  const A = parseVer(a);
  const B = parseVer(b);
  if (!A || !B) return 0;
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i];
  return 0;
}

function readPkgVersion(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function inDocker() {
  return fs.existsSync('/.dockerenv');
}

function isGitRepo(root) {
  return fs.existsSync(path.join(root, '.git'));
}

async function run(cmd, args, cwd, timeout = 120000) {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd,
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
  });
  return `${stdout || ''}${stderr || ''}`.trim();
}

function snapshot(state) {
  return {
    running: state.running,
    stage: state.stage,
    log: state.log.slice(-40),
    error: state.error,
    current: state.current,
    latest: state.latest,
    latestNotes: state.latestNotes,
    available: state.available,
    reason: state.reason,
    docker: state.docker,
  };
}

module.exports = function createUpdate({ sendJson, root, repo = process.env.UPDATE_REPO || 'XinYaoDev/creator-inbox', log = console.log }) {
  const state = {
    running: false,
    stage: 'idle',
    log: [],
    error: '',
    current: readPkgVersion(root),
    latest: '',
    latestNotes: '',
    available: false,
    reason: '',
    docker: inDocker(),
  };

  const note = (line) => {
    const s = String(line || '').trim();
    if (!s) return;
    state.log.push(s);
    if (state.log.length > 80) state.log.splice(0, state.log.length - 80);
    log(`[update] ${s}`);
  };

  async function githubLatest() {
    const headers = { 'User-Agent': 'creator-inbox-updater', Accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 404) return { tag: '', notes: '' };
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || `GitHub HTTP ${r.status}`);
    return { tag: String(data.tag_name || ''), notes: String(data.body || data.name || '').slice(0, 400) };
  }

  async function gitBehindCount() {
    if (!isGitRepo(root)) return 0;
    try {
      await run('git', ['fetch', 'origin'], root, 60000);
    } catch (e) {
      throw new Error(`git fetch 失败：${e.stderr || e.message || e}`);
    }
    try {
      const n = await run('git', ['rev-list', '--count', 'HEAD..@{u}'], root, 15000);
      return Number(n) || 0;
    } catch {
      return 0;
    }
  }

  async function check() {
    state.current = readPkgVersion(root);
    state.docker = inDocker();
    state.error = '';
    const gh = await githubLatest();
    state.latest = gh.tag;
    state.latestNotes = gh.notes;
    const releaseNewer = Boolean(parseVer(gh.tag) && cmpVer(gh.tag, state.current) > 0);
    let behind = 0;
    if (isGitRepo(root) && !state.docker) {
      try { behind = await gitBehindCount(); } catch (e) {
        state.error = String(e.message || e);
      }
    }
    if (state.docker) {
      state.available = false;
      state.reason = 'docker';
    } else if (releaseNewer) {
      state.available = true;
      state.reason = 'release';
    } else if (behind > 0) {
      state.available = true;
      state.reason = 'git';
      if (!state.latest) state.latest = `origin +${behind}`;
    } else {
      state.available = false;
      state.reason = '';
    }
    return snapshot(state);
  }

  async function applyGit() {
    const dirty = await run('git', ['status', '--porcelain'], root, 15000);
    if (dirty) throw new Error('工作区有未提交改动，更新已取消（避免覆盖你正在改的文件）');
    note('git pull --ff-only');
    note(await run('git', ['pull', '--ff-only'], root, 120000));
  }

  async function applyTarball(tag) {
    const ver = tag.replace(/^v/i, '') || tag;
    const url = `https://codeload.github.com/${repo}/tar.gz/refs/tags/${encodeURIComponent(tag)}`;
    note(`下载 ${url}`);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'creator-inbox-updater' },
      signal: AbortSignal.timeout(120000),
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`下载更新包 HTTP ${r.status}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-upd-'));
    const tgz = path.join(tmp, 'src.tgz');
    fs.writeFileSync(tgz, Buffer.from(await r.arrayBuffer()));
    await run('tar', ['-xzf', tgz, '-C', tmp], tmp, 30000);
    const inner = fs.readdirSync(tmp).find((n) => n !== 'src.tgz' && fs.statSync(path.join(tmp, n)).isDirectory());
    if (!inner) throw new Error('更新包解压后是空的');
    const src = path.join(tmp, inner);
    note(`覆盖文件（保留 data/）← ${inner} ${ver}`);
    fs.cpSync(src, root, {
      recursive: true,
      filter: (p) => {
        const rel = path.relative(src, p);
        if (!rel || rel === '.') return true;
        const top = rel.split(path.sep)[0];
        return !['data', 'node_modules', '.git'].includes(top);
      },
    });
  }

  function relaunch() {
    note('重启服务');
    const child = require('node:child_process').spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    setTimeout(() => process.exit(0), 400);
  }

  async function apply() {
    if (inDocker()) throw new Error('Docker 里请重新构建镜像，不能用应用内更新');
    state.stage = 'fetching';
    state.error = '';
    state.log = [];
    try {
      await check();
      if (!state.available) throw new Error('当前已是最新');
      if (isGitRepo(root)) await applyGit();
      else {
        const tag = state.latest && parseVer(state.latest) ? state.latest : '';
        if (!tag) throw new Error('没有 GitHub Release，且本机不是 git 仓库');
        await applyTarball(tag.startsWith('v') ? tag : `v${tag}`);
      }
      state.stage = 'building';
      note('npm install');
      note(await run('npm', ['install'], root, 300000));
      note('npm run build');
      note(await run('npm', ['run', 'build'], root, 300000));
      state.current = readPkgVersion(root);
      state.stage = 'restarting';
      state.available = false;
      state.running = false;
      note('构建完成，即将重启');
      relaunch();
    } catch (e) {
      state.stage = 'error';
      state.running = false;
      state.error = String(e && e.message || e);
      note(state.error);
    }
  }

  return async function handle(req, res, u) {
    const p = u.pathname;
    if (req.method === 'GET' && p === '/api/update/status') return sendJson(res, 200, snapshot(state));
    if (req.method === 'GET' && p === '/api/update/check') {
      try { return sendJson(res, 200, await check()); } catch (e) {
        state.error = String(e.message || e);
        return sendJson(res, 200, snapshot(state));
      }
    }
    if (req.method === 'POST' && p === '/api/update/apply') {
      if (state.running) return sendJson(res, 200, { ok: false, error: '正在更新', ...snapshot(state) });
      if (inDocker()) return sendJson(res, 200, { ok: false, error: 'Docker 里请重新构建镜像', ...snapshot(state) });
      state.running = true;
      state.stage = 'fetching';
      state.error = '';
      apply().catch((e) => { state.stage = 'error'; state.running = false; state.error = String(e.message || e); });
      return sendJson(res, 200, { ok: true, started: true, ...snapshot(state) });
    }
    return sendJson(res, 404, { error: 'unknown update api' });
  };
};

module.exports.parseVer = parseVer;
module.exports.cmpVer = cmpVer;
module.exports.readPkgVersion = readPkgVersion;
