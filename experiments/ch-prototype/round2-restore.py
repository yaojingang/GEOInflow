"""Restore a verified archive only into a new database owned by round two."""

import argparse
import hashlib
import json
import os
import pathlib
import secrets
import subprocess
import time

PROJECT = 'liekan_ch_proto_round2_20261027'
ROOT = pathlib.Path(__file__).resolve().parents[2]
OUTPUT = ROOT / '.local/ch-prototype-round2'
DATA_DIRECTORY = '/var/tmp/' + PROJECT + '/source-pg-complete'
DATABASE = 'liekan_source_round2'


def execute(arguments, **kwargs):
    """Use explicit argv and this repository; never source application environment files."""
    return subprocess.run(arguments, cwd=ROOT, check=True, **kwargs)


def main():
    """Verify archive bytes, assert isolation, and refuse to overwrite any existing clone."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--backup-directory', required=True, type=pathlib.Path)
    args = parser.parse_args()
    directory = args.backup_directory.resolve()
    archive = directory / 'liekan-production.dump'
    expected = (directory / 'SHA256SUMS').read_text().split()[0]
    with archive.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    assert expected == actual, 'backup checksum mismatch'

    OUTPUT.mkdir(mode=0o700, parents=True, exist_ok=True)
    secret = OUTPUT / 'pg-password'
    if not secret.exists():
        secret.write_text(secrets.token_hex(32))
    secret.chmod(0o600)
    env = {**os.environ, 'PROTO_SOURCE_BACKUP': str(directory)}
    compose = ['docker', 'compose', '--env-file', '/dev/null', '-p', PROJECT,
               '-f', 'experiments/ch-prototype/compose-round2.yaml']
    # Restore sequentially before starting any queue or query service.
    execute(compose + ['up', '-d', '--wait', 'pg'], env=env)
    name = PROJECT + '-pg-1'
    info = json.loads(execute(['docker', 'inspect', name], capture_output=True, text=True).stdout)[0]
    assert info['Config']['Labels']['com.docker.compose.project'] == PROJECT
    assert any(m['Type'] == 'bind' and m['Destination'] == '/var/lib/postgresql/data'
               and m['Source'] == DATA_DIRECTORY for m in info['Mounts'])
    assert any(m['Destination'] == '/source-backup' and not m['RW']
               and m['Source'] == str(directory) for m in info['Mounts'])
    exists = execute(['docker', 'exec', name, 'psql', '-U', 'liekan_ch_proto', '-d', 'postgres',
                      '-Atc', "SELECT 1 FROM pg_database WHERE datname='liekan_source_round2'"],
                     capture_output=True, text=True).stdout.strip()
    assert not exists, 'clone already exists; restore refuses to overwrite it'
    for sql in ["ALTER SYSTEM SET max_wal_size='256MB'", 'SELECT pg_reload_conf()']:
        execute(['docker', 'exec', name, 'psql', '-U', 'liekan_ch_proto', '-d', 'postgres',
                 '-v', 'ON_ERROR_STOP=1', '-Atc', sql], stdout=subprocess.DEVNULL)
    execute(['docker', 'exec', name, 'createdb', '-U', 'liekan_ch_proto', DATABASE])
    with (OUTPUT / 'restore.log').open('w') as log:
        execute(['docker', 'exec', name, 'pg_restore', '--no-owner', '--no-acl', '--exit-on-error',
                 '-U', 'liekan_ch_proto', '-d', DATABASE, '/source-backup/liekan-production.dump'],
                stdout=log, stderr=log)
    # A stopped or interrupted restore never publishes this success record.
    evidence = {'project': PROJECT, 'sha256': actual, 'restoredAtUnix': time.time(),
                'exitCode': 0, 'containerId': info['Id'], 'dataDirectory': DATA_DIRECTORY,
                'database': DATABASE}
    (OUTPUT / 'restore-command-evidence.json').write_text(json.dumps(evidence, indent=2))
    print('Archive restored to the round-two clone; run round2-prepare.ts before extraction.')


if __name__ == '__main__':
    main()
