#!/usr/bin/env python3
"""Copy a live legacy PostgreSQL installation into an isolated same-host CH test stack.

Production commands are limited to inspect, read-only psql, and pg_dump. All
mutations use a frozen Compose model with per-run ownership labels. No cleanup,
production cutover, network activation, or source-service stop is implemented.
"""
import argparse
import copy
import fcntl
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
from urllib.parse import parse_qsl, unquote, urlsplit
import uuid

ROOT = Path(__file__).resolve().parent.parent
LABEL = 'io.liekan.test.run'
NETWORK_OPTIONS = {'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
                   'com.docker.network.bridge.gateway_mode_ipv6': 'isolated'}
LEGACY_NETWORK_OPTIONS = {'com.docker.network.bridge.inhibit_ipv4': 'true'}
APPS = ('app', 'log-worker', 'analytics-worker', 'warehouse-init', 'warehouse-worker',
        'warehouse-transition', 'warehouse-maintenance')
STORAGE = ('db', 'analytics-cache', 'warehouse-ch', 'warehouse-queue')
SERVICES = set(APPS + STORAGE)
IMAGE_DIGESTS = {
    'warehouse-ch': 'sha256:d426d2f612e1e189c90f9a3f8dcd85a03c6851273833817a296bb327e63aa7a7',
    'warehouse-queue': 'sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837',
}
# Published before the Docker tmpfs inspection fix (public candidate 93257f8d).
# Only this exact script may be replaced in a stopped, backup-only run.
SCRIPT_REFRESH_FROM = {'8debdb85093e113a6c9c898844ae6cf831cd782e999575166c38838ab835f2f3'}
KEEP = ('APP_SECRET', 'TWO_FACTOR_ENCRYPTION_KEY', 'LIEKAN_LOG_CREDENTIALS_KEY',
        'LIEKAN_LOG_PREVIOUS_KEYS', 'LIEKAN_AI_ENCRYPTION_KEY')
RETRY = {'warehouse-transition-input-not-drained', 'warehouse-transition-decisions-not-drained',
         'warehouse-transition-control-not-drained', 'warehouse-transition-results-not-drained',
         'warehouse-transition-not-drained', 'warehouse-transition-pending-control',
         'warehouse-transition-unpublished-results', 'warehouse-migration-owned-or-closed'}


class Refused(RuntimeError):
    pass


class Failed(Refused):
    def __init__(self, output=b''):
        # Never forward Docker inspection, SQL diagnostics or raw visitor data.
        if isinstance(output, str):
            output = output.encode()
        codes = re.findall(rb'\bwarehouse-[a-z][a-z0-9-]+\b', output)
        self.code = codes[-1].decode() if codes else 'command-failed'
        super().__init__(self.code)


def child_env():
    allowed = ('PATH', 'HOME', 'TMPDIR', 'SSH_AUTH_SOCK', 'DOCKER_HOST', 'DOCKER_CONTEXT',
               'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')
    result = {k: os.environ[k] for k in allowed if k in os.environ}
    result['COMPOSE_DISABLE_ENV_FILE'] = 'true'
    result['COMPOSE_PARALLEL_LIMIT'] = '1'
    return result


def command(args, *, data=None, output=None, timeout=None):
    with subprocess.Popen(args, cwd=ROOT, env=child_env(), stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                          stdout=output or subprocess.PIPE, stderr=subprocess.PIPE) as p:
        try:
            out, err = p.communicate(data, timeout=timeout)
        except BaseException:
            p.terminate()
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
            raise
        if p.returncode:
            raise Failed((out or b'') + err)
        return out or b''


def docker(*args, **kwargs):
    return command(['docker', *args], **kwargs)


def inspect(kind, name):
    return json.loads(docker(kind, 'inspect', name))[0]


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def atomic(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    if path.is_symlink() or temporary.is_symlink():
        raise Refused('Symlink in private state path')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def environment(info):
    return dict(v.split('=', 1) for v in info['Config'].get('Env', []) if '=' in v)


def labels(info):
    return info.get('Config', info).get('Labels') or {}


def literal(value, encode=True):
    if isinstance(value, str):
        return value.replace('$', '$$') if encode else value.replace('$$', '$')
    if isinstance(value, list):
        return [literal(v, encode) for v in value]
    if isinstance(value, dict):
        return {k: literal(v, encode) for k, v in value.items()}
    return value


def source_pair(app, db, project):
    a, d = inspect('container', app), inspect('container', db)
    al, dl = labels(a), labels(d)
    production = al.get('com.docker.compose.project')
    if (not production or production != dl.get('com.docker.compose.project') or production == project
            or al.get('com.docker.compose.service') != 'app' or dl.get('com.docker.compose.service') != 'db'):
        raise Refused('Source app/db must belong to the same, different production Compose project')
    if not a['State']['Running'] or not d['State']['Running']:
        raise Refused('Source containers must already be running; this command will not start them')
    directory = al.get('com.docker.compose.project.working_dir')
    if not directory or ROOT.resolve() == Path(directory).resolve() or Path(directory).resolve() in ROOT.resolve().parents:
        raise Refused('Use a separate checkout, not the production Compose working directory')
    for container in (a, d):
        for mount in container.get('Mounts', []):
            if mount['Type'] == 'bind' and (ROOT == Path(mount['Source']) or Path(mount['Source']) in ROOT.parents):
                raise Refused('The test checkout is inside a production bind mount')
    ae, de = environment(a), environment(d)
    try:
        url = urlsplit(ae['DATABASE_URL'])
        host, port = url.hostname, url.port or 5432
        dbname, user = unquote(url.path.lstrip('/')), unquote(url.username or '')
        password = unquote(url.password or '')
    except (KeyError, ValueError):
        raise Refused('Cannot verify source database connection') from None
    networks = a['NetworkSettings']['Networks'].keys() & d['NetworkSettings']['Networks'].keys()
    names = {d['Name'].lstrip('/')}
    for network in networks:
        endpoint = d['NetworkSettings']['Networks'][network]
        names.update(endpoint.get('Aliases') or [])
        names.update(endpoint.get('DNSNames') or [])
        names.add(endpoint.get('IPAddress'))
    query = dict(parse_qsl(url.query, keep_blank_values=True))
    if (not networks or url.fragment or set(query) - {'sslmode', 'schema'}
            or query.get('schema', 'public') != 'public'
            or url.scheme not in ('postgres', 'postgresql') or host not in names or port != 5432
            or dbname != de.get('POSTGRES_DB', de.get('POSTGRES_USER'))
            or user != de.get('POSTGRES_USER') or password != de.get('POSTGRES_PASSWORD')):
        raise Refused('Source app does not point to the selected database container')
    if any(not ae.get(k) for k in KEEP[:2]):
        raise Refused('Source APP_SECRET or TWO_FACTOR_ENCRYPTION_KEY is missing')
    return a, d


def source_sql(db, sql):
    return docker('exec', '-i', '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000',
                  db['Id'], 'sh', '-c', 'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
                  data=sql.encode()).decode().strip()


def source_metadata(db):
    version = int(source_sql(db, "SELECT current_setting('server_version_num');"))
    if not 120000 <= version < 170000:
        raise Refused('This test restore supports source PostgreSQL 12–16 only')
    for table in ('public.liekan_warehouse_installation', 'liekan_test_harness.restore'):
        exists = source_sql(db, f"SELECT to_regclass('{table}') IS NOT NULL;")
        if exists == 't' and (table != 'public.liekan_warehouse_installation' or
                             source_sql(db, f'SELECT count(*) FROM {table};') != '0'):
            raise Refused('Source is already a warehouse or a test restore; a PG-only live dump is not supported')
    return {'version': version, 'bytes': int(source_sql(db, 'SELECT pg_database_size(current_database());'))}


def source_signature():
    paths = ['docker-compose.liekan.yml', 'docker-compose.warehouse.yml', 'scripts/liekan-warehouse-deploy.py',
             'scripts/liekan-warehouse-init.sh', 'scripts/liekan-warehouse-test.py', 'config/liekan/migrations.json']
    return {p: sha(ROOT / p) for p in paths}


def check_project(project):
    if not re.fullmatch(r'geoinflow-test-[a-z0-9][a-z0-9-]{0,38}', project):
        raise Refused('Test project must start with geoinflow-test- and use lowercase letters, digits or hyphens')


def check_bind_readability(config, services):
    for service in services:
        for mount in config['services'][service].get('volumes', []):
            if mount['type'] == 'bind' and not Path(mount['source']).stat().st_mode & 0o004:
                # os.access as the root deployment user would hide this failure.
                # These are public repository files; never change private env/dump modes.
                raise Refused('Repository Docker bind file is not readable by container users; '
                              'set the referenced public configuration/script file to mode 0644')


def engine_network_options(version):
    parsed = re.match(r'^(\d+)\.(\d+)\.(\d+)(?:$|[-+])', version)
    if not parsed or tuple(map(int, parsed.groups())) < (26, 1, 4):
        raise Refused('Docker Engine 26.1.4+ is required; no daemon changes were made')
    # Both modes keep the internal bridge unaddressed. Docker 26/27 expose
    # InhibitIPv4; 28+ additionally have the dedicated isolated gateway mode.
    return dict(NETWORK_OPTIONS if int(parsed[1]) >= 28 else LEGACY_NETWORK_OPTIONS)


def validate_model(config, project, run_id, image, subnet=None, network_options=None):
    network_options = NETWORK_OPTIONS if network_options is None else network_options
    if network_options not in (NETWORK_OPTIONS, LEGACY_NETWORK_OPTIONS):
        raise Refused('Unsupported test network isolation policy')
    if config.get('name') != project or set(config['services']) != SERVICES:
        raise Refused('Unexpected test services/project')
    networks = config.get('networks', {})
    if set(networks) != {'default'} or not networks['default'].get('internal') or networks['default'].get('external'):
        raise Refused('Test network must be private and internal')
    if networks['default'].get('enable_ipv6') is not False:
        raise Refused('Test network must explicitly disable IPv6')
    expected_ipam = {'config': [{'subnet': subnet}]} if subnet else {}
    ipam = dict(networks['default'].get('ipam') or {})
    ipam.pop('driver', None)
    if ipam != expected_ipam or networks['default']['name'] != project + '_default':
        raise Refused('Test network cannot reuse a subnet or another network name')
    if networks['default'].get('driver', 'bridge') != 'bridge' or networks['default'].get('driver_opts') != network_options:
        raise Refused('Test network must isolate the host gateway')
    for name, volume in config['volumes'].items():
        if volume.get('external') or volume.get('driver_opts') or volume.get('driver', 'local') != 'local':
            raise Refused('Only independent local named volumes are supported')
        if volume['name'] != project + '_' + name or volume.get('labels', {}).get(LABEL) != run_id:
            raise Refused('Unexpected test volume identity')
    for name, service in config['services'].items():
        if (service.get('ports') or service.get('container_name') or service.get('network_mode')
                or service.get('privileged') or service.get('external_links') or service.get('devices')
                or set(service.get('networks', {})) != {'default'} or service.get('labels', {}).get(LABEL) != run_id):
            raise Refused('Test service escapes isolation')
        if name in APPS and service['image'] != image:
            raise Refused('Application image must use the private test tag')
        env = service.get('environment', {})
        if name in APPS:
            db_env = config['services']['db']['environment']
            expected_url = f"postgresql://{db_env['POSTGRES_USER']}:{db_env['POSTGRES_PASSWORD']}@db:5432/{db_env['POSTGRES_DB']}"
            if env.get('DATABASE_URL') != expected_url or env.get('CLICKHOUSE_URL') or env.get('LIEKAN_ANALYTICS_CLICKHOUSE_URL'):
                raise Refused('Test database connection escapes the isolated stack')
            if env.get('LIEKAN_CLICKHOUSE_URL') != 'http://warehouse-ch:8123' or env.get('LIEKAN_QUEUE_BROKERS') != 'warehouse-queue:9092':
                raise Refused('Test warehouse connection escapes the isolated stack')
        if service.get('build') and (name != 'app' or Path(service['build']['context']).resolve() != ROOT
                                     or service['build'].get('dockerfile') != 'Dockerfile.liekan'):
            raise Refused('Unexpected application build context')
        for mount in service.get('volumes', []):
            if mount['type'] == 'volume':
                if mount['source'] not in config['volumes']:
                    raise Refused('Unknown data volume')
            elif mount['type'] == 'bind':
                path = Path(mount['source']).resolve()
                if not mount.get('read_only') or not path.is_file() or ROOT / 'docker' not in path.parents:
                    raise Refused('Unexpected host bind mount')
            else:
                raise Refused('Unsupported mount type')
        temporary = service.get('tmpfs', [])
        allowed_temporary = [
            '/etc/kafka/secrets:rw,nosuid,nodev,size=16m,uid=1000,gid=1000',
            '/mnt/shared/config:rw,nosuid,nodev,size=16m,uid=1000,gid=1000',
        ] if name == 'warehouse-queue' else []
        if temporary and sorted(temporary) != sorted(allowed_temporary):
            raise Refused('Unexpected temporary mount')


class TestStack:
    def __init__(self, args):
        self.args = args
        check_project(args.project)
        self.directory = ROOT / '.local' / args.project
        self.state_path = self.directory / 'state.json'
        if self.directory.is_symlink() or self.state_path.is_symlink():
            raise Refused('Private state paths cannot be symlinks')
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else None
        config_file = (self.state or {}).get('config_file', 'compose.json')
        if not re.fullmatch(r'compose(?:\.images-[a-f0-9]{32})?\.json', config_file):
            raise Refused('Unexpected frozen configuration filename')
        self.config_path = self.directory / config_file

    def save(self):
        atomic(self.state_path, self.state)

    def compose(self, *args, **kwargs):
        return command(['docker', 'compose', '--project-name', self.args.project,
                        '--env-file', str(self.directory / 'test.env'), '-f', str(self.config_path), *args], **kwargs)

    def config(self):
        if self.config_path.is_symlink() or sha(self.config_path) != self.state['config_sha']:
            raise Refused('Frozen test Compose configuration changed')
        c = literal(json.loads(self.config_path.read_text()), False)
        validate_model(c, self.args.project, self.state['run_id'], self.state['image'], self.state.get('subnet'),
                       self.state.get('network_options', NETWORK_OPTIONS))
        return c

    def guard(self, *, recovery=False):
        """Reject adoption, foreign mounts/networks and changed source/runtime inputs."""
        if self.state['root'] != str(ROOT) or self.state['project'] != self.args.project:
            raise Refused('State belongs to another checkout/project')
        if self.state['daemon'] != json.loads(docker('info', '--format', '{{json .ID}}')):
            raise Refused('Docker daemon changed')
        if not recovery and self.args.command in ('run', 'serve', 'refresh-images', 'refresh-script', 'check-storage'):
            # Refuse an unsafe daemon downgrade; read-only status and stopping
            # owned containers remain available for recovery.
            supported = engine_network_options(docker('version', '--format', '{{.Server.Version}}').decode().strip())
            if self.state.get('network_options', NETWORK_OPTIONS) == NETWORK_OPTIONS and supported == LEGACY_NETWORK_OPTIONS:
                raise Refused('This run uses isolated gateways and needs Docker 28+; status/stop remain available')
        if not recovery and self.args.command in ('run', 'check-storage') and self.state['signature'] != source_signature():
            raise Refused('Deployment source changed; keep this run on its original revision')
        config = self.config()
        for path, digest in self.state.get('bind_sha', {}).items():
            if sha(path) != digest:
                raise Refused('Read-only dependency configuration changed')
        if sha(self.directory / 'test.env') != self.state['env_sha']:
            raise Refused('Private test environment changed')
        volumes = {v['name'] for v in config['volumes'].values()}
        network = self.args.project + '_default'
        for kind, names in [('volume', volumes), ('network', {network})]:
            existing = set(docker(kind, 'ls', '--format', '{{.Name}}').decode().splitlines())
            for name in names & existing:
                info = inspect(kind, name)
                if labels(info).get(LABEL) != self.state['run_id']:
                    raise Refused('Existing resource is not owned by this test run')
                if kind == 'network' and (not info.get('Internal') or info.get('EnableIPv6') or
                                         info.get('Options') != config['networks']['default']['driver_opts']):
                    raise Refused('Test network lost internal isolation')
                if kind == 'volume' and (info.get('Driver') != 'local' or info.get('Options')):
                    raise Refused('Test volume changed its backing storage')
        ids = docker('ps', '-aq').decode().split()
        owned = []
        if ids:
            for container in json.loads(docker('inspect', *ids)):
                lab = labels(container)
                ours = lab.get('com.docker.compose.project') == self.args.project
                mounted = {m.get('Name') for m in container.get('Mounts', []) if m['Type'] == 'volume'}
                attached = set(container['NetworkSettings'].get('Networks', {}))
                if not ours:
                    if mounted & volumes or network in attached:
                        raise Refused('Foreign container shares a test volume/network')
                    continue
                service = lab.get('com.docker.compose.service')
                if lab.get(LABEL) != self.state['run_id'] or service not in SERVICES:
                    raise Refused('Existing container is not owned by this test run')
                if container['Id'] in self.state['source_ids'] or attached - {network} or not mounted <= volumes:
                    raise Refused('Test container uses a foreign resource')
                expected = {v['target']: v for v in config['services'][service].get('volumes', [])}
                temporary = dict(v.split(':', 1) for v in config['services'][service].get('tmpfs', []))
                # Docker can omit Compose tmpfs from Mounts. HostConfig.Tmpfs
                # retains the declared targets/options, including after exit.
                actual_temporary = container['HostConfig'].get('Tmpfs') or {}
                if ({k: sorted(v.split(',')) for k, v in actual_temporary.items()} !=
                        {k: sorted(v.split(',')) for k, v in temporary.items()}):
                    raise Refused('Test container temporary mounts changed')
                mounts = container.get('Mounts', [])
                if (len({m['Destination'] for m in mounts}) != len(mounts) or
                        {m['Destination'] for m in mounts if m['Type'] != 'tmpfs'} != set(expected)):
                    raise Refused('Test container mounts changed')
                for mount in mounts:
                    if mount['Type'] == 'tmpfs' and mount['Destination'] in temporary:
                        if mount.get('RW') is False:
                            raise Refused('Test container temporary mounts changed')
                        continue
                    spec = expected.get(mount['Destination'])
                    if not spec or mount['Type'] != spec['type'] or (mount['Type'] == 'volume' and
                            (mount.get('Name') != config['volumes'][spec['source']]['name'] or
                             mount['RW'] != (not spec.get('read_only', False)))) or (mount['Type'] == 'bind' and
                            (mount['RW'] or Path(mount['Source']).resolve() != Path(spec['source']).resolve())):
                        raise Refused('Test container mounts changed')
                if container['HostConfig'].get('PortBindings') or container['HostConfig'].get('Privileged'):
                    raise Refused('Test container publishes ports or gained privileges')
                if service in APPS and self.state.get('image_id') and container['Image'] != self.state['image_id']:
                    raise Refused('Test application image changed')
                actual_env = environment(container)
                expected_env = config['services'][service].get('environment', {})
                for key in ('DATABASE_URL', 'CLICKHOUSE_URL', 'LIEKAN_ANALYTICS_CLICKHOUSE_URL',
                            'LIEKAN_CLICKHOUSE_URL', 'LIEKAN_QUEUE_BROKERS', 'LIEKAN_QUEUE_STORAGE_PATH', *KEEP):
                    if actual_env.get(key, '') != str(expected_env.get(key) or ''):
                        raise Refused('Test container connection/private configuration changed')
                owned.append(container)
        return owned

    def prepare(self):
        if self.state:
            self.guard()
            self.status()
            return
        for kind in ('volume', 'network'):
            existing = docker(kind, 'ls', '--format', '{{.Name}}').decode().splitlines()
            if any(name.startswith(self.args.project + '_') for name in existing):
                raise Refused('Test project already has resources but no owned state; choose a new project')
        if docker('ps', '-aq', '--filter', 'label=com.docker.compose.project=' + self.args.project).strip():
            raise Refused('Test project already has containers but no owned state; choose a new project')
        a, d = source_pair(self.args.source_app, self.args.source_db, self.args.project)
        meta = source_metadata(d)
        engine = docker('version', '--format', '{{.Server.Version}}').decode().strip()
        network_options = engine_network_options(engine)
        if self.args.subnet:
            network = ipaddress.ip_network(self.args.subnet, strict=True)
            if network.version != 4 or not network.is_private or not 24 <= network.prefixlen <= 28:
                raise Refused('Test subnet must be a private IPv4 /24 through /28')
            ids = docker('network', 'ls', '-q').decode().split()
            if ids:
                for existing in json.loads(docker('network', 'inspect', *ids)):
                    for entry in existing.get('IPAM', {}).get('Config') or []:
                        other = ipaddress.ip_network(entry['Subnet']) if entry.get('Subnet') else None
                        if other and other.version == network.version and network.overlaps(other):
                            raise Refused('Requested test subnet overlaps an existing Docker network')
        summary = {'source_project': labels(a)['com.docker.compose.project'], 'source_database_bytes': meta['bytes'],
                   'source_pg_version': meta['version'], 'test_project': self.args.project,
                   'docker_version': engine, 'network_options': network_options,
                   'checkout': str(ROOT), 'state_directory': str(self.directory),
                   'disk_free_bytes': os.statvfs(ROOT).f_bavail * os.statvfs(ROOT).f_frsize,
                   'note': 'Source stays online. CPU, memory and disk IO are still shared. No production traffic is redirected.'}
        print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
        if self.args.command == 'plan':
            return
        if self.directory.exists():
            raise Refused('Incomplete preparation directory retained; use a new test project name after fixing the error')
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        run_id = str(uuid.uuid4())
        self.state = {'version': 1, 'run_id': run_id, 'root': str(ROOT), 'project': self.args.project,
                      'source_ids': [a['Id'], d['Id']], 'source_project': summary['source_project'],
                      'source_db': d['Id'], 'signature': source_signature(), 'source': meta,
                      'daemon': json.loads(docker('info', '--format', '{{json .ID}}')),
                      'image': f'{self.args.project}:run-{run_id}', 'done': {},
                      'subnet': self.args.subnet, 'network_options': network_options,
                      'snapshot_id': str(uuid.uuid4()), 'cutover_id': str(uuid.uuid4())}
        password = secrets.token_hex(32)
        values = {k: environment(a)[k] for k in KEEP if environment(a).get(k)}
        values.update(POSTGRES_USER='liekan', POSTGRES_DB='liekan', POSTGRES_PASSWORD=password,
                      DATABASE_URL=f'postgresql://liekan:{password}@db:5432/liekan',
                      LIEKAN_CLICKHOUSE_PASSWORD=secrets.token_hex(32), LIEKAN_INSTALL_MODE='pg-transition',
                      LIEKAN_SEED_DEMO='false', LIEKAN_AI_ENABLED='false', LIEKAN_PUBLIC_URL='',
                      DISABLE_TELEMETRY='1', NEXT_TELEMETRY_DISABLED='1')
        with (self.directory / 'test.env').open('x') as f:
            for key, value in values.items():
                if '\n' in value or '\r' in value:
                    raise Refused('Multiline private configuration is unsupported')
                f.write(key + '=' + json.dumps(value, ensure_ascii=False).replace('$', '$$') + '\n')
        # YAML override tags remove the base fixed subnet and published ports.
        yaml = ['services:']
        for name in SERVICES:
            yaml += [f'  {name}:', f'    labels: {{"{LABEL}": "{run_id}"}}']
            if name in APPS:
                yaml += [f'    image: {self.state["image"]}']
            if name in ('app', 'db'):
                yaml += ['    ports: !override []', '    cpus: 1.0', '    mem_limit: 2g']
            if name == 'log-worker':
                yaml += ['    cpus: 1.0', '    mem_limit: 1g']
            if name == 'warehouse-init':
                yaml += ['    cpus: 1.0', '    mem_limit: 2g']
            if name == 'analytics-cache':
                # Redis declares /data as an image VOLUME even with persistence
                # disabled. Name and label it instead of creating an orphan.
                yaml += ['    volumes:', '      - liekan-test-cache:/data']
        yaml += ['volumes:', '  liekan-test-cache: {}']
        yaml += ['networks:', '  default: !override', '    internal: true',
                 '    enable_ipv6: false',
                 '    driver_opts: ' + json.dumps(network_options),
                 f'    labels: {{"{LABEL}": "{run_id}"}}']
        if self.args.subnet:
            yaml += ['    ipam:', '      config:', f'        - subnet: {self.args.subnet}']
        overlay = self.directory / 'override.yml'
        overlay.write_text('\n'.join(yaml) + '\n')
        rendered = command(['docker', 'compose', '--project-name', self.args.project, '--env-file', str(self.directory / 'test.env'),
                            '-f', 'docker-compose.liekan.yml', '-f', 'docker-compose.warehouse.yml', '-f', str(overlay),
                            'config', '--format', 'json'])
        config = literal(json.loads(rendered), False)
        for volume in config['volumes'].values():
            volume.setdefault('labels', {})[LABEL] = run_id
        validate_model(config, self.args.project, run_id, self.state['image'], self.args.subnet, network_options)
        atomic(self.config_path, literal(config))
        self.state.update(config_sha=sha(self.config_path), env_sha=sha(self.directory / 'test.env'))
        self.state['bind_sha'] = {v['source']: sha(v['source']) for s in config['services'].values()
                                  for v in s.get('volumes', []) if v['type'] == 'bind'}
        self.save()
        self.guard()

    def step(self, name, action):
        self.guard()
        if name in self.state['done']:
            return self.state['done'][name]
        print(f'[{name}] running', flush=True)
        result = action()
        self.state['done'][name] = result if result is not None else True
        self.save()
        print(f'[{name}] complete', flush=True)
        return self.state['done'][name]

    def render_existing_config(self):
        overlay = self.directory / 'override.yml'
        if overlay.is_symlink() or not overlay.is_file():
            raise Refused('Missing original test override')
        rendered = command(['docker', 'compose', '--project-name', self.args.project,
                            '--env-file', str(self.directory / 'test.env'), '-f', 'docker-compose.liekan.yml',
                            '-f', 'docker-compose.warehouse.yml', '-f', str(overlay), 'config', '--format', 'json'])
        config = literal(json.loads(rendered), False)
        for volume in config['volumes'].values():
            volume.setdefault('labels', {})[LABEL] = self.state['run_id']
        return config

    def refresh_images(self):
        """Replace only CH/queue images before any test resource has been created."""
        owned = self.guard()
        if owned or set(self.state['done']) != {'backup'} or self.state.get('image_id') or self.state.get('pending'):
            raise Refused('Image refresh requires a backup-only run with no test resources')
        current = self.config()
        for kind in ('volume', 'network'):
            names = docker(kind, 'ls', '--format', '{{.Name}}').decode().splitlines()
            if any(name.startswith(self.args.project + '_') for name in names):
                raise Refused('Image refresh cannot change a run with existing test resources')
        if docker('image', 'ls', '-q', '--filter', 'reference=' + self.state['image']).strip():
            raise Refused('Image refresh cannot change a run with a built application image')
        receipt = json.loads((self.directory / 'backup.json').read_text())
        archive = self.directory / 'source.dump'
        if (archive.is_symlink() or not archive.is_file() or receipt != self.state['done']['backup']
                or receipt.get('source_container') != self.state['source_db']
                or archive.stat().st_size != receipt.get('bytes') or sha(archive) != receipt.get('sha256')):
            raise Refused('Backup receipt, size or checksum does not match')
        signature = source_signature()
        allowed = {'scripts/liekan-warehouse-test.py', 'docker-compose.warehouse.yml'}
        if (set(signature) != set(self.state['signature']) or
                any(signature[k] != self.state['signature'][k] for k in signature if k not in allowed)):
            raise Refused('Image refresh cannot accept unrelated deployment source changes')
        config = self.render_existing_config()
        expected = copy.deepcopy(current)
        for service in IMAGE_DIGESTS:
            expected['services'][service]['image'] = config['services'][service]['image']
        if config != expected:
            raise Refused('Image refresh would change configuration beyond CH/queue images')
        for service, argument in [('warehouse-ch', 'clickhouse_image'), ('warehouse-queue', 'queue_image')]:
            ref = getattr(self.args, argument, None) or config['services'][service]['image']
            if not ref.endswith('@' + IMAGE_DIGESTS[service]) or ref.count('@') != 1:
                raise Refused('Image must use the approved immutable digest')
            info = inspect('image', ref)
            if not any(v.endswith('@' + IMAGE_DIGESTS[service]) for v in info.get('RepoDigests', [])):
                raise Refused('Download the approved image before refreshing configuration')
            config['services'][service]['image'] = ref
        validate_model(config, self.args.project, self.state['run_id'], self.state['image'],
                       self.state.get('subnet'), self.state.get('network_options', NETWORK_OPTIONS))
        if config == current and signature == self.state['signature']:
            print('Images already refreshed; verified backup retained. No services started.')
            return
        # Commit a pointer only after a new immutable file is durable. An
        # interrupted attempt leaves the previous state/config pair usable.
        destination = self.directory / ('compose.images-' + uuid.uuid4().hex + '.json')
        atomic(destination, literal(config))
        updated = copy.deepcopy(self.state)
        updated.setdefault('image_refreshes', []).append({
            'config_file': self.config_path.name, 'config_sha': self.state['config_sha'],
            'signature': self.state['signature'], 'backup_sha256': receipt['sha256'],
        })
        updated.update(config_file=destination.name, config_sha=sha(destination), signature=signature)
        atomic(self.state_path, updated)
        self.state, self.config_path = updated, destination
        print('Images refreshed; verified backup retained. No services started.')

    def refresh_script(self):
        """Accept the reviewed guard fix without replacing a completed backup."""
        def stopped_probes():
            owned = self.guard()
            if (set(self.state['done']) != {'backup'} or self.state.get('image_id') or self.state.get('pending')
                    or any(labels(c).get('com.docker.compose.service') not in ('warehouse-ch', 'warehouse-queue')
                           or c['State']['Status'] not in ('created', 'exited')
                           or c['State'].get('Running') or c['State'].get('Restarting') for c in owned)):
                raise Refused('Script refresh requires backup-only state and stopped storage probes')
            return {c['Id'] for c in owned}

        ids = stopped_probes()
        if docker('image', 'ls', '-q', '--filter', 'reference=' + self.state['image']).strip():
            raise Refused('Script refresh cannot change a run with a built application image')
        signature = source_signature()
        previous = self.state['signature']
        script = 'scripts/liekan-warehouse-test.py'
        if (set(signature) != set(previous) or
                any(signature[k] != previous[k] for k in signature if k != script) or
                (previous[script] != signature[script] and previous[script] not in SCRIPT_REFRESH_FROM)):
            raise Refused('Script refresh only accepts the published tmpfs guard fix; other source changes refused')
        archive = self.directory / 'source.dump'
        receipt_path = self.directory / 'backup.json'
        if archive.is_symlink() or receipt_path.is_symlink() or not archive.is_file():
            raise Refused('Backup files must remain regular files')
        receipt = json.loads(receipt_path.read_text())
        if (receipt != self.state['done']['backup'] or receipt.get('source_container') != self.state['source_db']
                or archive.stat().st_size != receipt.get('bytes') or sha(archive) != receipt.get('sha256')):
            raise Refused('Backup receipt, size or checksum does not match')
        if stopped_probes() != ids:
            raise Refused('Storage probes changed during script refresh')
        if signature == previous:
            print('Script already refreshed; verified backup and frozen configuration retained.')
            return
        updated = copy.deepcopy(self.state)
        updated.setdefault('script_refreshes', []).append({
            'signature': previous, 'backup_sha256': receipt['sha256'], 'config_sha': self.state['config_sha'],
        })
        updated['signature'] = signature
        atomic(self.state_path, updated)
        self.state = updated
        print('Script refreshed; verified backup and frozen configuration retained. No services started.')

    def check_storage(self):
        """Check real CH/queue health before building an app or restoring PG."""
        self.guard()
        if set(self.state['done']) != {'backup'}:
            raise Refused('Storage check is only available before application build/restore')
        services = {'warehouse-ch', 'warehouse-queue'}
        try:
            self.up(sorted(services))
            print('ClickHouse and queue health checks passed. PostgreSQL was not started.')
        finally:
            # Stop only guarded immutable IDs, including on health timeout.
            targets = [c['Id'] for c in self.guard(recovery=True)
                       if labels(c).get('com.docker.compose.service') in services]
            if targets:
                docker('stop', '--time', '30', *targets)
            print('Storage probe containers stopped; test volumes and backup retained.')

    def backup(self):
        target = self.directory / 'source.dump'
        receipt = self.directory / 'backup.json'
        if receipt.exists():
            value = json.loads(receipt.read_text())
            if value['sha256'] != sha(target):
                raise Refused('Source dump checksum changed')
            return value
        if target.exists():
            raise Refused('Dump has no completion receipt; preserved for inspection')
        db = inspect('container', self.state['source_db'])
        source_metadata(db)
        part = self.directory / 'source.dump.partial'
        if part.is_symlink() or (part.exists() and (not part.is_file() or part.stat().st_nlink != 1)):
            raise Refused('Unexpected partial backup file')
        # This path belongs to this locked run only. Reuse an incomplete dump,
        # instead of accumulating another whole copy on every interrupted retry.
        with part.open('wb') as f:
            docker('exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on', db['Id'], 'sh', '-c',
                   'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=1 --lock-wait-timeout=5s', output=f)
            f.flush()
            os.fsync(f.fileno())
        digest = sha(part)
        os.rename(part, target)
        result = {'sha256': digest, 'bytes': target.stat().st_size, 'source_container': db['Id']}
        atomic(receipt, result)
        return result

    def sql(self, sql):
        return self.compose('exec', '-T', 'db', 'sh', '-c',
                            'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
                            data=sql.encode()).decode().strip()

    def restore(self):
        backup = self.state['done']['backup']
        if sha(self.directory / 'source.dump') != backup['sha256']:
            raise Refused('Source dump checksum changed')
        exists = self.sql("SELECT to_regclass('liekan_test_harness.restore') IS NOT NULL;")
        if exists == 't':
            marker = self.sql('SELECT run_id || chr(9) || sha256 FROM liekan_test_harness.restore;')
            if marker != self.state['run_id'] + '\t' + backup['sha256']:
                raise Refused('Restore receipt belongs to another source/run')
            return {'sha256': backup['sha256']}
        if self.sql("SELECT count(*) FROM pg_tables WHERE schemaname NOT IN('pg_catalog','information_schema');") != '0':
            raise Refused('Target is not empty; existing database will not be overwritten')
        prefix = ['docker', 'compose', '--project-name', self.args.project, '--env-file', str(self.directory / 'test.env'),
                  '-f', str(self.config_path), 'exec', '-T', 'db', 'sh', '-c']
        with (self.directory / 'source.dump').open('rb') as archive, \
                subprocess.Popen(prefix + ['exec pg_restore --no-owner --no-acl --file=-'], stdin=archive,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=child_env()) as restore, \
                subprocess.Popen(prefix + ['exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
                                 stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 env=child_env()) as psql:
            try:
                # Explicit COMMIT comes only after pg_restore succeeds and the
                # receipt is appended. EOF, signals and decode errors roll back.
                psql.stdin.write(b'BEGIN;\n')
                while True:
                    data = restore.stdout.read(1024 * 1024)
                    if not data:
                        break
                    psql.stdin.write(data)
                if restore.wait() != 0:
                    raise Refused('Dump decoding failed; target transaction was not committed')
                marker = ("\nCREATE SCHEMA liekan_test_harness;\n"
                          "CREATE TABLE liekan_test_harness.restore(run_id text PRIMARY KEY,sha256 text NOT NULL);\n"
                          f"INSERT INTO liekan_test_harness.restore VALUES('{self.state['run_id']}','{backup['sha256']}');\nCOMMIT;\n")
                psql.stdin.write(marker.encode())
                psql.stdin.close()
                if psql.wait() != 0:
                    raise Refused('Restore transaction failed; no completion was recorded')
            finally:
                if not psql.stdin.closed:
                    psql.stdin.close()
                if restore.poll() is None:
                    restore.terminate()
        return {'sha256': backup['sha256']}

    def check_ledger(self):
        rows = self.sql('SELECT name || chr(9) || checksum FROM liekan_migration ORDER BY name;')
        expected = json.loads((ROOT / 'config/liekan/migrations.json').read_text())
        if not rows or any(expected.get(row.split('\t')[0]) != row.split('\t')[1] for row in rows.splitlines()):
            raise Refused('Restored migration ledger is unknown or changed')
        self.sql('ANALYZE;')

    def image(self):
        if self.args.app_image:
            info = inspect('image', self.args.app_image)
            if labels(info).get('org.opencontainers.image.title') != 'GEOInflow':
                raise Refused('Prebuilt image must be a GEOInflow application image')
            docker('tag', info['Id'], self.state['image'])
        else:
            self.compose('build', 'app')
        self.state['image_id'] = inspect('image', self.state['image'])['Id']
        self.save()
        return self.state['image_id']

    def up(self, names):
        self.guard()
        check_bind_readability(self.config(), names)
        self.compose('up', '-d', '--no-build', '--no-deps', '--wait', '--wait-timeout', '300', *names)

    def deploy(self):
        # Reuse dependency preflight and PG-preserving startup from the existing
        # deployer; every Compose call is bound to our validated frozen model.
        spec = importlib.util.spec_from_file_location('warehouse_deploy', ROOT / 'scripts/liekan-warehouse-deploy.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.compose = lambda *args, capture=False: self.compose(*args).decode()
        check_bind_readability(self.config(), STORAGE)
        plan = module.dependency_plan(self.config(), list(STORAGE))
        module.dependencies(plan)
        self.guard()
        self.compose('stop', '-t', '120', *[s for s in APPS if s != 'warehouse-init'])
        self.compose('run', '--rm', '--no-deps', 'warehouse-init')
        self.up(['app'])
        self.up([s for s in APPS if s not in ('app', 'warehouse-init')])

    def wh(self, *args, clone=False, output=None):
        self.guard()
        options = []
        if clone:
            name = self.state['done']['clone']['descriptor']['database']
            if not re.fullmatch(r'liekan_snapshot_[a-z0-9_]+', name):
                raise Refused('Invalid immutable clone descriptor')
            options = ['-e', 'LIEKAN_MIGRATION_CLONE=' + name]
        return self.compose('exec', '-T', *options, 'app', 'node', 'scripts/liekan-warehouse-command.mjs',
                            *args, output=output)

    def warehouse_step(self, name, args, *, clone=False, uncertain=False, retry=False):
        def execute():
            result_path = self.directory / (name + '.jsonl')
            def read_result():
                try:
                    result = json.loads(result_path.read_text().splitlines()[-1])
                except (ValueError, IndexError):
                    return None
                if not isinstance(result, dict) or result.get('error'):
                    return None
                if name == 'archive':
                    if (not re.fullmatch(r'[a-f0-9]{64}', str(result.get('sha256', '')))
                            or not re.fullmatch(r'/app/warehouse-backups/snapshot_[a-f0-9-]+', str(result.get('directory', '')))
                            or result.get('archive') != result['directory'] + '/source.dump'
                            or not isinstance(result.get('boundary'), dict)):
                        return None
                if name == 'clone' and not re.fullmatch(r'liekan_snapshot_[a-f0-9]+', str(result.get('descriptor', {}).get('database', ''))):
                    return None
                return result
            if result_path.exists():
                prior = read_result()
                # Only a complete success receipt can reconcile a lost response.
                if uncertain and prior is not None:
                    return prior
            if uncertain and self.state.get('pending') == name:
                raise Refused(f'{name} completion is uncertain; inspect preserved archive/descriptor before proceeding')
            self.state['pending'] = name
            self.save()
            deadline = time.monotonic() + self.args.wait_seconds
            while True:
                try:
                    with result_path.open('wb') as output:
                        self.wh(*args, clone=clone, output=output)
                        output.flush()
                        os.fsync(output.fileno())
                    result = read_result()
                    if result is None:
                        raise Refused(f'{name} returned no valid completion receipt')
                    self.state.pop('pending', None)
                    return result
                except Failed as error:
                    # Warehouse CLI errors are deliberately emitted to stdout.
                    if result_path.exists():
                        error = Failed(result_path.read_bytes()[-8192:])
                    if not retry or error.code not in RETRY or time.monotonic() >= deadline:
                        raise error
                    print(f'[{name}] waiting: {error.code}', flush=True)
                    time.sleep(5)
        return self.step(name, execute)

    def migrate(self):
        s = self.warehouse_step('preflight', ['preflight'])
        if s.get('compatible') is not True or s.get('errors'):
            raise Refused('Source fact schema is incompatible')
        snapshot = self.state['snapshot_id']
        self.warehouse_step('snapshot-barrier', ['barrier', '--kind', 'snapshot', '--operation', snapshot], retry=True)
        self.warehouse_step('snapshot-freeze', ['freeze', '--operation', snapshot], retry=True)
        archive = self.warehouse_step('archive', ['snapshot-export', '--directory', '/app/warehouse-backups'], uncertain=True)
        self.warehouse_step('clone', ['snapshot-restore', '--archive', archive['archive'], '--sha256', archive['sha256'],
                                     '--directory', '/app/warehouse-backups', '--boundary', archive['directory'] + '/archive.json'], uncertain=True)
        registered = self.warehouse_step('register', ['register'], clone=True)
        migration = registered['migrationId']
        self.warehouse_step('snapshot-resume', ['resume-snapshot', '--operation', snapshot])
        self.warehouse_step('backfill', ['backfill', '--migration', migration], clone=True, retry=True)
        self.warehouse_step('verify', ['verify', '--migration', migration], clone=True, retry=True)
        self.warehouse_step('baseline', ['baseline', '--migration', migration])
        self.warehouse_step('baseline-sync', ['sync'])
        cutover = self.state['cutover_id']
        self.warehouse_step('cutover-barrier', ['barrier', '--kind', 'cutover', '--operation', cutover], retry=True)
        self.warehouse_step('cutover-freeze', ['freeze', '--operation', cutover], retry=True)
        self.warehouse_step('cutover-sync', ['sync'])
        self.warehouse_step('cutover-switch', ['switch', '--operation', cutover], retry=True)
        self.warehouse_step('exit-begin', ['exit-begin'])
        self.warehouse_step('exit-sync', ['sync'])
        self.warehouse_step('exit-complete', ['exit-complete'], retry=True)
        status = json.loads(self.wh('transition-status'))
        if (status['installation'][0]['authority'] != 'clickhouse' or
                status['installation'][0]['transition'] != 'exited' or status['transition'][0]['state'] != 'closed'):
            raise Refused('Test warehouse has not completed cutover')
        atomic(self.directory / 'final-status.json', status)
        print('Test CH migration complete; production was not switched. Old test PG facts are retained.', flush=True)

    def run(self):
        if self.state:
            self.guard()
        else:
            self.prepare()
        self.step('backup', self.backup)
        if self.args.until == 'backup':
            return
        self.step('image', self.image)
        if inspect('image', self.state['image'])['Id'] != self.state['image_id']:
            raise Refused('Test image tag changed')
        self.up(['db'])
        self.step('restore', self.restore)
        self.step('ledger', self.check_ledger)
        self.step('deploy', self.deploy)
        # A stopped, owned run may resume without re-running initialization.
        self.up(list(STORAGE))
        self.up(['app'])
        self.up([s for s in APPS if s not in ('app', 'warehouse-init')])
        if self.args.until == 'deploy':
            self.status()
            return
        self.migrate()
        self.status()

    def status(self):
        owned = self.guard()
        print(json.dumps({'project': self.args.project, 'completed': list(self.state['done']),
                          'pending': self.state.get('pending'), 'image': self.state['image'],
                          'containers': [{'service': labels(c).get('com.docker.compose.service'),
                                          'status': c['State']['Status']} for c in owned]}, indent=2))
        app = next((c for c in owned if labels(c).get('com.docker.compose.service') == 'app' and c['State']['Running']), None)
        if app:
            print(f'On the server: python3 scripts/liekan-warehouse-test.py serve --project {self.args.project}')
            print('From your computer: ssh -N -L 127.0.0.1:3003:127.0.0.1:3003 USER@SERVER')
            print('Open http://127.0.0.1:3003 and use the existing account from the backup.')

    def serve(self):
        app = self.relay_app
        if not app:
            raise Refused('The owned test app is not running')
        # The isolated bridge has no host address. Forward over Docker exec,
        # without adding a second network, publishing ports or changing rules.
        relay = ("const n=require('node:net');const s=n.connect(3000,'127.0.0.1');"
                 "s.setTimeout(120000,()=>s.destroy());s.on('error',()=>process.exit(1));"
                 "process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit());")
        limit = threading.BoundedSemaphore(16)
        app_id = app['Id']
        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                if not limit.acquire(blocking=False):
                    return
                p = None
                try:
                    self.request.settimeout(120)
                    p = subprocess.Popen(['docker', 'exec', '-i', app_id, 'node', '-e', relay], env=child_env(),
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                    def send():
                        try:
                            while data := self.request.recv(65536):
                                p.stdin.write(data)
                                p.stdin.flush()
                        except (OSError, ValueError):
                            pass
                        finally:
                            try:
                                p.stdin.close()
                            except (OSError, ValueError):
                                pass
                    threading.Thread(target=send, daemon=True).start()
                    while data := p.stdout.read1(65536):
                        self.request.sendall(data)
                except (OSError, ValueError):
                    pass
                finally:
                    if p:
                        p.terminate()
                        try:
                            p.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            p.kill()
                            p.wait()
                        p.stdout.close()
                    try:
                        self.request.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    limit.release()
        class Server(socketserver.ThreadingTCPServer):
            daemon_threads = True
            allow_reuse_address = True
        with Server(('127.0.0.1', self.args.port), Handler) as server:
            print(f'Test UI relay: http://127.0.0.1:{self.args.port} (Ctrl-C stops only this relay)', flush=True)
            server.serve_forever()

    def stop(self):
        owned = self.guard()
        if owned:
            docker('stop', '--time', '120', *[c['Id'] for c in owned])
        print('Only owned test containers stopped; volumes and backup retained.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan', 'run', 'status', 'stop', 'serve', 'refresh-images', 'refresh-script', 'check-storage'])
    parser.add_argument('--source-app', default='liekan-app-1')
    parser.add_argument('--source-db', default='liekan-db-1')
    parser.add_argument('--project', default='geoinflow-test-ch')
    parser.add_argument('--until', choices=['backup', 'deploy', 'complete'], default='complete')
    parser.add_argument('--app-image', help='Reuse a locally built GEOInflow image by ID/tag; copied to an independent test tag')
    parser.add_argument('--subnet', help='Optional unused private IPv4 subnet when Docker address pools are exhausted')
    parser.add_argument('--wait-seconds', type=int, default=900, help='Bounded wait for durable drain/lease retries')
    parser.add_argument('--port', type=int, default=3003, help='serve only: bind the UI relay to 127.0.0.1 on this port')
    parser.add_argument('--clickhouse-image', help='refresh-images only: downloaded image at the approved CH digest')
    parser.add_argument('--queue-image', help='refresh-images only: downloaded image at the approved queue digest')
    args = parser.parse_args()
    if args.wait_seconds < 0:
        parser.error('--wait-seconds must be nonnegative')
    if not 1024 <= args.port <= 65535:
        parser.error('--port must be between 1024 and 65535')
    if args.command != 'refresh-images' and (args.clickhouse_image or args.queue_image):
        parser.error('Image overrides are only accepted by refresh-images')
    os.umask(0o077)
    check_project(args.project)
    if args.command == 'plan':
        TestStack(args).prepare()
        return
    local = ROOT / '.local'
    if local.is_symlink() or (local / args.project).is_symlink():
        raise Refused('Private state directories cannot be symlinks')
    local.mkdir(mode=0o700, exist_ok=True)
    # Separate controller lock; no production lock or service is touched.
    lock_path = local / (args.project + '.lock')
    if lock_path.is_symlink():
        raise Refused('Lock path is a symlink')
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Read the persisted checkpoints only after acquiring the controller lock.
        stack = TestStack(args)
        if args.command in ('status', 'stop', 'serve', 'refresh-images', 'refresh-script', 'check-storage') and not stack.state:
            raise Refused('No test state exists for this project')
        if args.command != 'serve':
            getattr(stack, args.command.replace('-', '_'))()
            return
        owned = stack.guard()
        stack.relay_app = next((c for c in owned if labels(c).get('com.docker.compose.service') == 'app' and c['State']['Running']), None)
    # A long-lived UI relay must not prevent status/stop. Its exec target is the
    # immutable, guarded app container ID, never a name that could be reused.
    serve_lock = local / (args.project + '.serve.lock')
    if serve_lock.is_symlink():
        raise Refused('Relay lock path is a symlink')
    with serve_lock.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stack.serve()


if __name__ == '__main__':
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except (Refused, BlockingIOError) as error:
        print(f'Stopped: {error}', file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print('Interrupted; completed stages retained. Re-run the same command to resume.', file=sys.stderr)
        sys.exit(130)
    except (OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError):
        print('Stopped: runtime/configuration failure. Private inputs were not printed; existing data is retained.', file=sys.stderr)
        sys.exit(1)
