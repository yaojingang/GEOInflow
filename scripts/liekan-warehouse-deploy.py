#!/usr/bin/env python3
"""Install/update the warehouse stack while preserving existing private settings."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
FILES = ['-f', 'docker-compose.liekan.yml', '-f', 'docker-compose.warehouse.yml']
COMPOSE_OPTIONS = []


def compose(*args, capture=False):
    return subprocess.run(['docker', 'compose', *COMPOSE_OPTIONS, *FILES, *args], cwd=ROOT, check=True,
                          text=True, stdout=subprocess.PIPE if capture else None).stdout


def private_config(mode, path, project):
    existing = subprocess.check_output(['docker', 'volume', 'ls', '--format', '{{.Name}}'], text=True).splitlines()
    if not path.exists():
        if any(v in {f'{project}_{key}' for key in ['liekan-data', 'liekan-warehouse-ch', 'liekan-warehouse-queue']} for v in existing):
            raise RuntimeError('Existing data found. Restore the original private .env before deployment.')
        password = secrets.token_hex(32)
        values = dict(POSTGRES_USER='liekan', POSTGRES_DB='liekan', POSTGRES_PASSWORD=password,
                      DATABASE_URL=f'postgresql://liekan:{password}@127.0.0.1:15435/liekan',
                      APP_SECRET=secrets.token_hex(32), TWO_FACTOR_ENCRYPTION_KEY=secrets.token_hex(32),
                      DISABLE_TELEMETRY='1', NEXT_TELEMETRY_DISABLED='1', DEFAULT_LOCALE='zh-CN',
                      API_KEY_ENABLED='1', LIEKAN_AI_ENABLED='false')
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(''.join(f'{k}={v}\n' for k, v in values.items()))
            f.flush()
            os.fsync(f.fileno())
    text = path.read_text()
    keys = {line.split('=', 1)[0].strip() for line in text.splitlines() if '=' in line and not line.lstrip().startswith('#')}
    additions = {}
    if 'LIEKAN_CLICKHOUSE_PASSWORD' not in keys and not os.environ.get('LIEKAN_CLICKHOUSE_PASSWORD'):
        if f'{project}_liekan-warehouse-ch' in existing:
            raise RuntimeError('Existing ClickHouse volume found. Restore its original password; it will not be regenerated.')
        additions['LIEKAN_CLICKHOUSE_PASSWORD'] = secrets.token_hex(32)
    if 'LIEKAN_INSTALL_MODE' not in keys:
        additions['LIEKAN_INSTALL_MODE'] = mode
    if additions:
        with path.open('a') as f:
            f.write('\n' + ''.join(f'{k}={v}\n' for k, v in additions.items()))
            f.flush()
            os.fsync(f.fileno())
    os.environ['LIEKAN_INSTALL_MODE'] = mode


def dependency_plan(config, names):
    """Refuse unapplied storage configuration before starting or stopping anything.

    PostgreSQL intentionally retains its original container/major version. Other
    dependencies must match their resolved Compose config; silently starting an
    old CH/queue container would ignore the operator's resource/engine changes.
    """
    plan = []
    for name in names:
        ids = compose('ps', '--all', '--quiet', name, capture=True).split()
        if len(ids) > 1:
            raise RuntimeError(f'Multiple {name} containers found; deployment stopped.')
        if ids:
            if name != 'db':
                info = json.loads(subprocess.check_output(['docker', 'inspect', ids[0]], text=True))[0]
                if name == 'warehouse-queue' and any(
                    m.get('Destination') == '/var/lib/redpanda/data' for m in info.get('Mounts', [])
                ):
                    raise RuntimeError('Existing Redpanda queue found. No services were changed. Kafka cannot adopt its volume, topic IDs or pending messages. Keep the original stack; test PG-to-CH migration in a separate project. See docs/warehouse.md.')
                expected = compose('config', '--hash', name, capture=True).split()
                if len(expected) != 2 or expected[0] != name or not re.fullmatch(r'[a-f0-9]{64}', expected[1]):
                    raise RuntimeError(f'Cannot verify {name} Compose configuration; deployment stopped.')
                actual = (info.get('Config', {}).get('Labels') or {}).get('com.docker.compose.config-hash')
                if actual != expected[1]:
                    raise RuntimeError(f'{name} runtime configuration differs from Compose. No services were changed. Back up, stop all application/worker writers, explicitly reconcile this service with its reviewed image, volume and credentials, then retry. See docs/warehouse.md.')
            plan.append((name, ids[0]))
        else:
            for mount in config['services'][name].get('volumes', []):
                if mount.get('type') == 'volume':
                    volume = config['volumes'][mount['source']]['name']
                    found = subprocess.run(['docker', 'volume', 'inspect', volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    if found.returncode == 0:
                        raise RuntimeError(f'{name} has a data volume but no container. Restore it with its original image first.')
            plan.append((name, None))
    return plan


def dependencies(plan):
    for name, container in plan:
        if container:
            # Keep the original PG image, mounts and credentials. Compose up may
            # otherwise replace an old-major dependency during an application update.
            subprocess.run(['docker', 'start', container], check=True, stdout=subprocess.DEVNULL)
            import time
            for _ in range(150):
                state = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True))[0]['State']
                if state.get('Health', {}).get('Status') == 'healthy':
                    break
                if not state.get('Running') or state.get('Health', {}).get('Status') == 'unhealthy':
                    raise RuntimeError(f'{name} is unhealthy; restore the existing service first.')
                time.sleep(2)
            else:
                raise RuntimeError(f'{name} health timeout.')
        else:
            compose('up', '-d', '--no-build', '--no-deps', '--wait', '--wait-timeout', '300', name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['fresh', 'pg-transition'], required=True)
    parser.add_argument('--no-build', action='store_true', help='Use an already built application image')
    parser.add_argument('--env-file',type=Path,default=ROOT/'.env')
    parser.add_argument('--project',default=os.environ.get('COMPOSE_PROJECT_NAME','liekan'))
    parser.add_argument('--compose-override',type=Path,action='append',default=[])
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{2,62}',args.project):raise RuntimeError('Invalid project name.')
    args.env_file=args.env_file.resolve()
    COMPOSE_OPTIONS.extend(['--env-file',str(args.env_file),'--project-name',args.project])
    for override in args.compose_override:FILES.extend(['-f',str(override.resolve())])
    os.umask(0o077)
    (ROOT / '.local').mkdir(exist_ok=True)
    # Same OS lock as the legacy deployment script. Released on every exit.
    import fcntl
    with (ROOT / '.local/liekan-deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        private_config(args.mode,args.env_file,args.project)
        config = json.loads(compose('config', '--format', 'json', capture=True))
        plan = dependency_plan(config, ['db', 'analytics-cache', 'warehouse-ch', 'warehouse-queue'])
        if not args.no_build:
            compose('build', 'app')
        dependencies(plan)
        compose('stop', '-t', '120', 'app', 'log-worker', 'analytics-worker', 'warehouse-worker', 'warehouse-transition', 'warehouse-maintenance')
        # A failure leaves old writers stopped. Retrying resumes the same durable
        # installation; never restart an unfenced writer against a partial upgrade.
        compose('run', '--rm', '--no-deps', 'warehouse-init')
        compose('up', '-d', '--no-build', '--no-deps', '--wait', '--wait-timeout', '300', 'app')
        compose('up', '-d', '--no-build', '--no-deps', '--wait', '--wait-timeout', '300',
                'log-worker', 'analytics-worker', 'warehouse-worker', 'warehouse-transition', 'warehouse-maintenance')
        print('GEOInflow warehouse services ready: http://127.0.0.1:3002')
        if args.mode == 'pg-transition':
            print('Unfinished PostgreSQL upgrades require migration, verification and explicit cutover. Completed installations keep their stored authority.')
        print('Existing accounts and configuration are preserved. Initial installations use admin / liekan.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, BlockingIOError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError:
        print('Deployment command failed. Services were not automatically rolled back; inspect health and retry.', file=sys.stderr)
        sys.exit(1)
