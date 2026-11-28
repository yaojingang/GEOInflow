"""Extract a bounded pseudonymized fixture from the verified local archive."""

import hashlib
import json
import os
import pathlib
import subprocess

PROJECT = 'liekan_ch_proto_round2_20261027'
ROOT = pathlib.Path(__file__).resolve().parents[2]
OUTPUT = ROOT / '.local/ch-prototype-round2'


def main():
    """Scan archive COPY rows in memory, saving only 32 masked protocol fixtures."""
    info = json.loads(subprocess.check_output(['docker', 'inspect', PROJECT + '-pg-1']))[0]
    assert info['Config']['Labels']['com.docker.compose.project'] == PROJECT
    backup = pathlib.Path(next(m['Source'] for m in info['Mounts']
                               if m['Destination'] == '/source-backup' and not m['RW']))
    archive = backup / 'liekan-production.dump'
    expected = (backup / 'SHA256SUMS').read_text().split()[0]
    with archive.open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == expected
    salt = (OUTPUT / 'pg-password').read_bytes()

    def masked(value):
        """Retain equality relationships while removing source identifiers and paths."""
        return hashlib.sha256(salt + value.encode()).hexdigest()

    proc = subprocess.Popen(['pg_restore', '--data-only', '--table=website_event', '--file=-',
                             str(archive)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True)
    columns = None
    samples = []
    count = 0
    for line in proc.stdout:
        if line.startswith('COPY public.website_event '):
            columns = line.split('(', 1)[1].split(')', 1)[0].split(', ')
            continue
        if line.startswith('\\.'):
            columns = None
            continue
        if not columns:
            continue
        count += 1
        if len(samples) < 32:
            row = dict(zip(columns, line.rstrip('\n').split('\t')))
            samples.append(dict(id=masked(row['event_id']), uuid=masked(row['event_id']),
                                site=masked(row['website_id']), session=masked(row['session_id']),
                                visit=masked(row['visit_id']), path=masked(row['url_path']), cents=0,
                                properties={}, kind='browser', source='browser',
                                scope='browser_unresolved', policyVersion=1))
    assert proc.wait() == 0, 'archive extraction failed'
    assert count > 0 and samples
    (OUTPUT / 'protocol-samples.json').write_text(json.dumps(samples))
    os.chmod(OUTPUT / 'protocol-samples.json', 0o600)
    evidence = {'rowsScanned': count, 'sampleRows': len(samples), 'backupSha256': expected,
                'source': 'website_event from verified production dump',
                'method': 'first 32 archive rows, pseudonymized; controlled fault-case variants, '
                          'not a representative traffic sample'}
    (OUTPUT / 'protocol-sample-evidence.json').write_text(json.dumps(evidence, indent=2))
    print('Backup event sample extracted:', len(samples), 'from', count, 'rows')


if __name__ == '__main__':
    main()
