import { execFileSync, spawn } from 'node:child_process';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logPublicOrigin } from '../lib/liekan/contracts/installation';
import { parseCombinedDate } from '../lib/liekan/strict-date';
import { atomicWrite, openRegularLog } from './collector';
import { pairingDecision } from './pairing-decision';

class SetupError extends Error {}
const directory = '/var/lib/liekan-agent';
const pointer = join(directory, 'source-id');
const logPath = `/logs/${process.env.LIEKAN_LOG_FILE || ''}`;
const url = logPublicOrigin(process.env.LIEKAN_PUBLIC_URL || '');
const websiteId = process.env.LIEKAN_WEBSITE_ID;
const hostLogDirectory = process.env.LIEKAN_LOG_DIRECTORY;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

async function configuration() {
  let source = await readFile(pointer, 'utf8').catch(() => '');
  // Recover a configuration persisted before an interrupted pointer write.
  if (!source) {
    const candidates = (await readdir(directory)).filter(name => uuid.test(name));
    const configured: string[] = [];
    for (const name of candidates)
      if (
        await readFile(join(directory, name, 'config.json')).then(
          () => true,
          () => false,
        )
      )
        configured.push(name);
    if (configured.length > 1) throw new SetupError('持久卷中存在多个采集配置，请保留配置并检查。');
    if (configured.length === 1) {
      source = configured[0];
      await atomicWrite(pointer, source);
    }
  }
  if (!source) return null;
  if (!uuid.test(source)) throw new SetupError('持久卷中的来源标识无效，请保留配置并检查。');
  const path = join(directory, source, 'config.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (
    config.sourceId !== source ||
    config.url !== url ||
    config.logPath !== logPath ||
    config.websiteId !== websiteId ||
    config.hostLogDirectory !== hostLogDirectory
  )
    throw new SetupError('已有采集配置与接收地址或日志路径不一致，请保留配置并核对部署目录。');
  return { path, config };
}

async function exchange(code: string, failure: string) {
  if (!url || !websiteId || !hostLogDirectory) throw new SetupError('接收地址或日志文件名无效。');
  let source: string;
  try {
    source = execFileSync(
      process.execPath,
      [
        '/app/agent.mjs',
        'pair',
        '--url',
        url,
        '--code',
        code,
        '--log',
        logPath,
        '--directory',
        directory,
        '--website',
        websiteId,
        '--host-log-directory',
        hostLogDirectory,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    throw new SetupError(failure);
  }
  if (!uuid.test(source)) throw new SetupError('配对响应无效。');
  await atomicWrite(pointer, source);
}

async function preflight() {
  if (
    !url ||
    !uuid.test(websiteId || '') ||
    !hostLogDirectory?.startsWith('/') ||
    !/^[A-Za-z0-9_.-]+$/.test(process.env.LIEKAN_LOG_FILE || '')
  )
    throw new SetupError('接收地址或日志文件名无效。');
  await readdir(dirname(logPath)).catch(() => {
    throw new SetupError('日志目录无法读取，请检查目录权限及只读挂载。');
  });
  const file = await openRegularLog(logPath).catch(() => {
    throw new SetupError('日志文件无法读取，请检查路径、用户组权限及 SELinux 策略。');
  });
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
    await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start) lines.shift();
    lines.pop(); // A partial final line will be collected when completed.
    const samples = lines.filter(line => line.trim()).slice(-20);
    const combined =
      /^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Z]+) (.*?) HTTP\/[\d.]+" (\d{3}) (\d+|-) "[^"]*" "([^"]*)"$/;
    if (
      samples.some(line => {
        const match = line.match(combined);
        if (!match) return true;
        try {
          parseCombinedDate(match[2]);
          return false;
        } catch {
          return true;
        }
      })
    )
      throw new SetupError('日志格式无法识别，请为该网站启用 Nginx / Apache Combined 访问日志。');
    console.log(
      samples.length
        ? '日志路径、权限和 Combined 格式检查通过。'
        : '日志可读取，当前没有完整日志行；启动后等待新增访问。',
    );
  } finally {
    await file.close();
  }
  const probe = join(directory, '.write-check');
  await atomicWrite(probe, 'ready');
  await unlink(probe);
  const response = await fetch(`${url}/api/heartbeat`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  }).catch(() => {
    throw new SetupError('无法连接统计服务，请检查容器网络、DNS 和 HTTPS 证书。');
  });
  if (!response.ok) throw new SetupError('统计服务健康检查失败，请检查公网接收地址。');
  await configuration();
  console.log('缓存目录和统计服务连接检查通过。');
}

async function main() {
  const command = process.argv[2] || 'run';
  if (command === 'preflight') return preflight();
  if (command === 'pair') {
    await preflight();
    const saved = await configuration();
    if (saved) {
      const response = await fetch(
        `${url}/api/liekan/log-sources/${saved.config.sourceId}/heartbeat`,
        {
          headers: { authorization: `Bearer ${saved.config.token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        },
      ).catch(() => {
        throw new SetupError('无法核对已有连接，已保留原配对和缓存，请检查网络后重试。');
      });
      if (response.ok) {
        const live = await response.json();
        if (live.version !== 1 || live.websiteId !== websiteId)
          throw new SetupError('已有来源与网站不一致，请保留配置并检查。');
        console.log('已有配对配置，继续使用原采集进度。');
        return;
      }
      if (![401, 403, 404, 409].includes(response.status))
        throw new SetupError('已有连接暂时无法核对，已保留原配对和缓存，请稍后重试。');
      console.log('已有连接凭据已失效，请使用新的配对码；原配置和缓存继续保留。');
    }
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 128) throw new SetupError('配对码格式无效。');
    }
    const code = input.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new SetupError('请在后台生成新的配对码。');
    await exchange(code, '配对失败或配对码已过期。环境已准备好，请回到后台生成新的配对码后重试。');
    console.log('配对完成，配置已保存到持久卷。');
    return;
  }
  let saved = await configuration();
  if (!saved) {
    const decision = pairingDecision(false, process.env.LIEKAN_PAIRING_CODE);
    if (decision.action === 'missing-code')
      throw new SetupError('尚未配对，请在 .env 配置一次性配对码，或运行安装脚本完成连接。');
    if (decision.action === 'invalid-code')
      throw new SetupError('配对码格式无效，请在后台生成新的配对码并更新 .env。');
    if (decision.action === 'pair' && command === 'run') {
      // Only the long-running entry pairs by itself; health probes stay read-only.
      await preflight();
      await exchange(
        decision.code,
        '配对失败或配对码已过期。请回到后台生成新的配对码，更新 .env 中的 LIEKAN_PAIRING_CODE 后重新启动容器。',
      );
      console.log('首次启动自动配对完成，长期接收凭据已保存到状态目录。');
      saved = await configuration();
      if (!saved) throw new SetupError('自动配对后未找到配置，请保留状态目录后重试。');
    }
  }
  if (!saved) throw new SetupError('尚未配对，请运行容器或安装脚本完成连接。');
  const readyPath = join(saved.config.stateDir, 'ready.json');
  if (command === 'health') {
    const ready = JSON.parse(await readFile(readyPath, 'utf8'));
    if (ready.sourceId !== saved.config.sourceId || !Number.isSafeInteger(ready.pid))
      throw new SetupError();
    process.kill(ready.pid, 0);
    return;
  }
  if (command !== 'run') throw new SetupError('使用 preflight、pair、run 或 health。');
  await unlink(readyPath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  const child = spawn(process.execPath, ['/app/agent.mjs', 'run', '--config', saved.path], {
    stdio: 'inherit',
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}
main().catch(error => {
  // Only controlled messages are rendered; configuration and raw log lines stay private.
  console.error(
    error instanceof SetupError
      ? error.message
      : '采集容器检查失败，请检查配置、挂载权限和持久卷。',
  );
  process.exitCode = 1;
});
