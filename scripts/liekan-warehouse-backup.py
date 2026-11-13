#!/usr/bin/env python3
"""Coherent offline backup/restore of PG, ClickHouse, queue and geography volumes.

A backup contains private visitor/business data and private configuration. Store
it on protected storage. Restore only creates empty, separately named volumes.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent
WRITERS = ['app', 'log-worker', 'analytics-worker', 'warehouse-worker', 'warehouse-transition', 'warehouse-maintenance']
DEPENDENCIES = ['db', 'warehouse-ch', 'warehouse-queue', 'analytics-cache']
VOLUMES = ['liekan-data', 'liekan-warehouse-ch', 'liekan-warehouse-queue', 'liekan-geography', 'liekan-warehouse-exports', 'liekan-warehouse-backups']


def run(args, capture=False):
    return subprocess.run(args, cwd=ROOT, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def base(env=None, project=None, overrides=()):
    cmd = ['docker', 'compose']
    if env:
        cmd += ['--env-file', str(env)]
    if project:
        cmd += ['--project-name', project]
    return cmd + ['-f', 'docker-compose.liekan.yml', '-f', 'docker-compose.warehouse.yml'] + [arg for path in overrides for arg in ['-f',str(path.resolve())]]


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('x') as f:
        json.dump(value, f, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    temporary.replace(path)


def compose_literals(value):
    """Decode the dollar escaping emitted by `docker compose config` once."""
    if isinstance(value, str):
        return value.replace('$$', '$')
    if isinstance(value, list):
        return [compose_literals(item) for item in value]
    if isinstance(value, dict):
        return {key: compose_literals(item) for key, item in value.items()}
    return value


def backup_configuration(config, encoding):
    if encoding == 'literal-v1':
        return config
    if encoding is not None:
        raise RuntimeError('Unsupported backup configuration encoding.')
    # Early v1 archives saved Compose serialization plus literal environment
    # values from container inspection. Decode the former, preserve the latter.
    environments = {name: service.get('environment', {}) for name, service in config['services'].items()}
    decoded = compose_literals(config)
    for name, environment in environments.items():
        decoded['services'][name]['environment'] = environment
    return decoded


def capture_file_mounts(config, directory):
    """Copy immutable service configuration; never carry live host paths into a restore."""
    files = set()
    for service in config['services'].values():
        if service.get('secrets') or service.get('configs'):
            raise RuntimeError('External Compose secrets/configs require an explicit backup mapping.')
        for mount in service.get('volumes', []):
            if mount.get('type') != 'bind':
                continue
            source = Path(mount['source'])
            if not mount.get('read_only') or not source.is_file():
                raise RuntimeError('Backup supports only read-only regular configuration file mounts; use named volumes for data.')
            content = source.read_bytes()
            relative = 'bind-config/' + hashlib.sha256(content).hexdigest()
            destination = directory / relative
            destination.parent.mkdir(mode=0o700, exist_ok=True)
            if not destination.exists():
                with destination.open('xb') as output:
                    output.write(content)
                    output.flush()
                    os.fsync(output.fileno())
                # The enclosing backup/config directories are private (0700).
                # The mounted file must remain readable by the storage image's
                # non-root UID, which differs from the host backup owner.
                # Keep owner-write on the source inode: older queue entrypoints
                # copy its mode to a private runtime file and overwrite it on
                # restart. The container mount itself remains read-only.
                os.chmod(destination, 0o644)
            mount['source'] = './' + relative
            files.add(relative)
    return files


def restore_file_mounts(config, directory, files):
    for service in config['services'].values():
        if service.get('secrets') or service.get('configs'):
            raise RuntimeError('Unmapped external configuration in backup.')
        for mount in service.get('volumes', []):
            if mount.get('type') != 'bind':
                continue
            source = mount['source']
            if not mount.get('read_only') or not re.fullmatch(r'\./bind-config/[a-f0-9]{64}', source) or source[2:] not in files:
                raise RuntimeError('Restore refuses a host mount outside the verified backup.')
            path = directory / source[2:]
            # Normalize early archives whose 0444 mode made the copied queue
            # bootstrap file impossible to overwrite on the second startup.
            os.chmod(path, 0o644)
            mount['source'] = str(path)


def verify_running_mounts(service, configured, actual, volumes):
    """A changed Compose file must not make us back up an unused/empty volume."""
    expected = {}
    for mount in configured.get('volumes', []):
        kind = mount['type']
        if kind not in ('bind', 'volume'):
            raise RuntimeError('Backup requires explicit volume or read-only configuration mounts.')
        source = mount['source']
        if kind == 'volume':
            if source not in VOLUMES:
                raise RuntimeError('Service uses a volume without a backup mapping.')
            source = volumes[source]['name']
        else:
            source = str(Path(source).resolve())
        expected[mount['target']] = (kind, source, not mount.get('read_only', False))
    observed = {}
    for mount in actual:
        # Kafka's image declares these generated-config directories as volumes.
        # Compose explicitly makes them disposable tmpfs; facts/cluster identity
        # must remain in the backed-up /var/lib/kafka/data named volume.
        if service == 'warehouse-queue' and mount['Type'] == 'tmpfs' and mount['Destination'] in ('/etc/kafka/secrets', '/mnt/shared/config'):
            declared = {item.split(':', 1)[0] for item in configured.get('tmpfs', [])}
            if mount['Destination'] in declared:
                continue
        # Redis is explicitly disposable in this stack (AOF and RDB disabled).
        if service == 'analytics-cache' and mount['Destination'] == '/data' and '/data' not in expected:
            continue
        source = mount.get('Name') if mount['Type'] == 'volume' else str(Path(mount['Source']).resolve())
        observed[mount['Destination']] = (mount['Type'], source, mount['RW'])
    if observed != expected:
        raise RuntimeError(f'{service} runtime mounts differ from Compose; reconcile them before backup.')


def remove_restore_installer(config):
    # The stopped volumes already contain the captured installation. A later
    # mutable image tag must never introduce a new installer during recovery.
    config['services'].pop('warehouse-init', None)
    for service in config['services'].values():
        dependencies = service.get('depends_on', {})
        if isinstance(dependencies, dict):
            dependencies.pop('warehouse-init', None)
        elif isinstance(dependencies, list):
            service['depends_on'] = [name for name in dependencies if name != 'warehouse-init']


def recovery_networks(config, project, *, activate=False):
    """Copies retain real provider credentials; inbound isolation is not enough.

    Recovery can drain the internal queue and inspect reports without reaching
    Cloudflare or any other external writer. A separately prepared activation
    configuration uses new networks, since Docker network flags are immutable.
    """
    networks = config.setdefault('networks', {})
    if not networks:
        networks['default'] = {}
    for key, network in networks.items():
        if network.get('external') or network.get('driver', 'bridge') != 'bridge':
            raise RuntimeError('Recovery requires private bridge networks.')
        network['name'] = f'{project}_{"active_" if activate else ""}{key}'
        network['internal'] = not activate
        network.pop('ipam', None)
        # A custom bridge device/options can bind the copy to an existing host
        # network. Recovery always allocates its own ordinary bridge.
        network.pop('driver_opts', None)
    for service in config['services'].values():
        if service.get('network_mode') or service.get('external_links'):
            raise RuntimeError('Recovery refuses shared container/host networking.')


def compose_escape(value):
    if isinstance(value, str): return value.replace('$', '$$')
    if isinstance(value, list): return [compose_escape(v) for v in value]
    if isinstance(value, dict): return {k: compose_escape(v) for k, v in value.items()}
    return value


def backup(args):
    directory = args.directory.resolve()
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    if not args.env_file.is_file():
        raise RuntimeError('Private .env is required.')
    command = base(args.env_file.resolve(),args.project,args.compose_override)
    config = compose_literals(json.loads(run([*command, 'config', '--format', 'json'], True)))
    volumes = {}
    for key in VOLUMES:
        name = config['volumes'][key]['name']
        run(['docker', 'volume', 'inspect', name], True)
        volumes[key] = name
    images = {}
    running = []
    for service in DEPENDENCIES + WRITERS:
        ids = run([*command, 'ps', '--all', '--quiet', service], True).split()
        if len(ids) != 1:
            raise RuntimeError(f'Expected one {service} container.')
        info = json.loads(run(['docker', 'inspect', ids[0]], True))[0]
        verify_running_mounts(service, config['services'][service], info['Mounts'], config['volumes'])
        image = json.loads(run(['docker', 'image', 'inspect', info['Image']], True))[0]
        images[service] = {'id': info['Image'], 'digests': image.get('RepoDigests', [])}
        config['services'][service]['environment'] = dict(item.split('=', 1) for item in info['Config']['Env'] if '=' in item)
        config['services'][service]['command'] = info['Config'].get('Cmd')
        config['services'][service]['entrypoint'] = info['Config'].get('Entrypoint')
        if info['Config'].get('Healthcheck', {}).get('Test'):
            config['services'][service].setdefault('healthcheck', {})['test'] = info['Config']['Healthcheck']['Test']
        if info['State']['Running']:
            running.append(service)
    shutil.copyfile(args.env_file, directory / 'private.env')
    os.chmod(directory / 'private.env', 0o600)
    # Resolve non-secret service images in the restore override. All binary
    # volume formats are restored with exactly the captured engine images.
    atomic_json(directory / 'images.compose.json', {
        'services': {service: {'image': entry['id']} for service, entry in images.items()}
    })
    try:
        run([*command, 'stop', '-t', '120', 'app'])
        run([*command, 'stop', '-t', '120', *WRITERS[1:]])
        run([*command, 'stop', '-t', '120', *DEPENDENCIES])
        # Every container sharing a captured volume must be stopped. This also
        # catches forgotten external workers/sidecars instead of copying live DBs.
        for volume in volumes.values():
            if run(['docker', 'ps', '--quiet', '--filter', f'volume={volume}'], True).strip():
                raise RuntimeError('A captured volume is still used by a running container.')
        configuration_files = capture_file_mounts(config, directory)
        atomic_json(directory / 'resolved.compose.json', config)
        for key, volume in volumes.items():
            run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '0',
                 '--mount', f'type=volume,source={volume},target=/source,readonly',
                 '--mount', f'type=bind,source={directory},target=/backup',
                 '--entrypoint', 'tar', images['db']['id'],
                 '-czf', f'/backup/{key}.tgz', '-C', '/source', '.'])
        if not args.skip_images:
            run(['docker', 'image', 'save', '--output', str(directory / 'images.tar'),
                 *sorted({entry['id'] for entry in images.values()})])
        files = {name: {'sha256': sha(directory / name), 'bytes': (directory / name).stat().st_size}
                 for name in [*(f'{v}.tgz' for v in VOLUMES), 'private.env', 'images.compose.json', 'resolved.compose.json', *sorted(configuration_files), *([] if args.skip_images else ['images.tar'])]}
        atomic_json(directory / 'manifest.json', {
            'format': 'liekan-warehouse-cold-backup-v1', 'createdAt': datetime.now(timezone.utc).isoformat(),
            'configurationEncoding': 'literal-v1',
            'project': config['name'], 'images': images, 'volumes': VOLUMES, 'files': files,
            'consistency': 'all writers and storage processes stopped; durable pending queue included',
        })
    finally:
        if args.restart:
            # Start existing containers only: no reconfiguration, migrations or
            # installation is implicit in taking a backup.
            for service in DEPENDENCIES + WRITERS:
                if service in running:
                    run([*command, 'start', service])
    print(f'Backup verified: {directory / "manifest.json"}')
    if not args.restart:
        print('Services remain stopped. Use the existing Compose configuration to start them when ready.')


def restore(args):
    directory = args.directory.resolve()
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest.get('format') != 'liekan-warehouse-cold-backup-v1' or manifest.get('volumes') != VOLUMES:
        raise RuntimeError('Unsupported backup format.')
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{2,62}', args.project) or args.project == manifest['project']:
        raise RuntimeError('Restore requires a distinct new project name.')
    expected = {*(f'{v}.tgz' for v in VOLUMES), 'private.env', 'images.compose.json', 'resolved.compose.json'}
    configuration_files = {name for name in manifest['files'] if re.fullmatch(r'bind-config/[a-f0-9]{64}', name)}
    if set(manifest['files']) - configuration_files not in (expected, expected | {'images.tar'}):
        raise RuntimeError('Incomplete backup manifest.')
    for name, identity in manifest['files'].items():
        path = directory / name
        if not path.is_file() or path.stat().st_size != identity['bytes'] or sha(path) != identity['sha256']:
            raise RuntimeError(f'Backup integrity check failed: {name}')
    if 'images.tar' in manifest['files']:
        run(['docker', 'image', 'load', '--input', str(directory / 'images.tar')])
    for entry in manifest['images'].values():
        present = subprocess.run(['docker', 'image', 'inspect', entry['id']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if present.returncode:
            if not entry['digests']:
                raise RuntimeError('Captured application image is missing. Load the exact saved image before restoring.')
            run(['docker', 'pull', entry['digests'][0]])
            run(['docker', 'image', 'inspect', entry['id']], True)
    config = backup_configuration(json.loads((directory / 'resolved.compose.json').read_text()), manifest.get('configurationEncoding'))
    restore_file_mounts(config, directory, configuration_files)
    remove_restore_installer(config)
    config['name'] = args.project
    for key, value in config['volumes'].items():
        if value.get('external'):
            raise RuntimeError('External volumes require a separate restore plan.')
        value['name'] = f'{args.project}_{key}'
    recovery_networks(config, args.project)
    for service, value in config['services'].items():
        if service in manifest['images']:
            value['image'] = manifest['images'][service]['id']
        value.pop('build', None)
        value.pop('ports', None)
        value.pop('container_name', None)
        if value.get('network_mode'):
            raise RuntimeError('Restore requires isolated Compose networking.')
        # The serialized config is literal. Escape Compose interpolation when
        # reusing captured secrets or shell commands containing dollar signs.
    restore_config = directory / f'restore-{args.project}.compose.json'
    atomic_json(restore_config, compose_escape(config))
    command = ['docker', 'compose', '--project-name', args.project, '-f', str(restore_config)]
    config = json.loads(run([*command, 'config', '--format', 'json'], True))
    if run([*command, 'ps', '--all', '--quiet'], True).strip():
        raise RuntimeError('Restore project already has containers.')
    destinations = {key: config['volumes'][key]['name'] for key in VOLUMES}
    for key, volume in destinations.items():
        if volume != f'{args.project}_{key}':
            raise RuntimeError('External/shared volumes are not valid restore destinations.')
        if subprocess.run(['docker', 'volume', 'inspect', volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            raise RuntimeError('Restore destination already exists; it will not be overwritten.')
    for key, volume in destinations.items():
        run(['docker', 'volume', 'create', '--label', f'com.docker.compose.project={args.project}',
             '--label', f'com.docker.compose.volume={key}', volume], True)
        run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '0',
             '--mount', f'type=volume,source={volume},target=/restore',
             '--mount', f'type=bind,source={directory},target=/backup,readonly',
             '--entrypoint', 'tar', manifest['images']['db']['id'],
             '-xzf', f'/backup/{key}.tgz', '-C', '/restore'])
    # Do not create/start network-facing services or rewrite the current .env.
    # Operator can assign different loopback ports before starting the restored
    # stack. Queue topic IDs, offsets and unfinished work survive as one unit.
    atomic_json(directory / f'restore-{args.project}.json', {'project': args.project, 'volumes': destinations,
                'composeArguments': command[2:], 'started': False, 'externalWrites': 'isolated'})
    print(f'Restored to separate volumes for {args.project}; no services started and no existing data overwritten.')
    print('Recovery networks block external traffic. Use activate --confirm-takeover only when this copy should take over external integrations.')


def activate(args):
    """Prepare explicit disaster-recovery takeover; never start services here."""
    if not args.confirm_takeover:
        raise RuntimeError('Activation requires --confirm-takeover: the original writers must be stopped and this copy will regain external integration write authority.')
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{2,62}', args.project):
        raise RuntimeError('Invalid restore project name.')
    directory = args.directory.resolve()
    descriptor = json.loads((directory / f'restore-{args.project}.json').read_text())
    if descriptor.get('project') != args.project or descriptor.get('externalWrites') != 'isolated':
        raise RuntimeError('Activation requires an isolated restore created by this tool.')
    restored = directory / f'restore-{args.project}.compose.json'
    command = ['docker', 'compose', '--project-name', args.project, '-f', str(restored)]
    config = compose_literals(json.loads(run([*command, 'config', '--format', 'json'], True)))
    if 'warehouse-init' in config['services']:
        raise RuntimeError('A recovered installation must not rerun its initializer.')
    for key in VOLUMES:
        expected = f'{args.project}_{key}'
        if descriptor.get('volumes', {}).get(key) != expected or config['volumes'][key].get('name') != expected or config['volumes'][key].get('external'):
            raise RuntimeError('Activation refuses shared or changed restored volumes.')
    if not config.get('networks') or any(not n.get('internal') for n in config['networks'].values()):
        raise RuntimeError('The recovery configuration no longer blocks external traffic.')
    ids = run([*command, 'ps', '--all', '--quiet'], True).split()
    for container in ids:
        info = json.loads(run(['docker', 'inspect', container], True))[0]
        if info['State']['Running']:
            raise RuntimeError('Stop all restored containers before preparing activation.')
    recovery_networks(config, args.project, activate=True)
    activated = directory / f'active-{args.project}.compose.json'
    atomic_json(activated, compose_escape(config))
    print(f'Activation configuration prepared: {activated}')
    print('No services started. Recreate the stopped restored services with this configuration to take over; do not run the original writers concurrently.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    b = sub.add_parser('backup')
    b.add_argument('--directory', type=Path, required=True)
    b.add_argument('--env-file',type=Path,default=ROOT/'.env')
    b.add_argument('--project',default=os.environ.get('COMPOSE_PROJECT_NAME','liekan'))
    b.add_argument('--compose-override',type=Path,action='append',default=[])
    b.add_argument('--restart', action='store_true')
    b.add_argument('--skip-images', action='store_true', help='Only if every captured image is already archived separately')
    r = sub.add_parser('restore')
    r.add_argument('--directory', type=Path, required=True)
    r.add_argument('--project', required=True)
    a = sub.add_parser('activate', help='Prepare external integration takeover for a stopped, isolated restore')
    a.add_argument('--directory', type=Path, required=True)
    a.add_argument('--project', required=True)
    a.add_argument('--confirm-takeover', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    import fcntl
    (ROOT / '.local').mkdir(exist_ok=True)
    with (ROOT / '.local/liekan-deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        {'backup': backup, 'restore': restore, 'activate': activate}[args.command](args)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, BlockingIOError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError:
        print('Backup/restore command failed; partial output is not a complete backup. Existing data was not overwritten.', file=sys.stderr)
        sys.exit(1)
