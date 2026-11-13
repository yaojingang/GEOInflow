"""Kafka volume guards using the pinned image; all writable data is temporary.

Only the last broker-launch step is stubbed. Normal broker/crash recovery is
covered separately by warehouse-queue-restart.integration.ts.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
IMAGE = 'apache/kafka:4.3.1@sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837'


class KafkaStartupTest(unittest.TestCase):
    def probe(self, fixture, succeeds):
        # Colima shares the workspace, not macOS's per-user /var/folders tmp.
        (ROOT / '.local').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / '.local', prefix='kafka-start-') as directory:
            stub = Path(directory) / 'run'
            stub.write_text('#!/bin/sh\nprintf "BOOTSTRAP_ACCEPTED:%s\\n" "$CLUSTER_ID"\n')
            stub.chmod(0o755)
            script = ROOT / 'docker/warehouse/kafka-start.sh'
            result = subprocess.run([
                'docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '--cpus', '1', '--memory', '512m', '--pids-limit', '128',
                '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m',
                '--tmpfs', '/var/lib/kafka/data:rw,nosuid,nodev,size=16m,uid=1000,gid=1000',
                '--tmpfs', '/etc/kafka/secrets:rw,nosuid,nodev,size=16m,uid=1000,gid=1000',
                '--tmpfs', '/mnt/shared/config:rw,nosuid,nodev,size=16m,uid=1000,gid=1000',
                '-e', 'KAFKA_HEAP_OPTS=-Xms32m -Xmx128m',
                '--mount', f'type=bind,source={script},target=/liekan/kafka-start.sh,readonly',
                '--mount', f'type=bind,source={stub},target=/etc/kafka/docker/run,readonly',
                '--entrypoint', 'sh', IMAGE, '-c',
                'set -eu; cd /var/lib/kafka/data; ' + fixture + '; sh /liekan/kafka-start.sh',
            ], capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0 if succeeds else 1, result.stderr)
            if succeeds: self.assertRegex(result.stdout, r'BOOTSTRAP_ACCEPTED:[A-Za-z0-9_-]{22}')
            else: self.assertNotIn('BOOTSTRAP_ACCEPTED', result.stdout)

    def test_empty_volume_initializes(self): self.probe(':', True)
    def test_interrupted_empty_uuid_file_retries(self): self.probe(': > .liekan-kafka-cluster-id.tmp', True)
    def test_interrupted_partial_uuid_file_retries(self): self.probe('echo partial > .liekan-kafka-cluster-id.tmp', True)
    def test_redpanda_volume_refused(self): self.probe('mkdir redpanda; echo existing > redpanda/segment', False)
    def test_temporary_file_with_existing_logs_refused(self): self.probe('mkdir logs; : > .liekan-kafka-cluster-id.tmp', False)
    def test_foreign_cluster_refused(self):
        self.probe("echo aaaaaaaaaaaaaaaaaaaaaa > .liekan-kafka-cluster-id; mkdir logs; echo cluster.id=bbbbbbbbbbbbbbbbbbbbbb > logs/meta.properties", False)
    def test_symlinked_marker_refused(self): self.probe('ln -s /tmp/foreign .liekan-kafka-cluster-id.tmp', False)


if __name__ == '__main__':
    if os.environ.get('WAREHOUSE_DOCKER_TEST') != 'isolated-new-project':
        raise SystemExit('Set WAREHOUSE_DOCKER_TEST=isolated-new-project for temporary Docker fixtures.')
    unittest.main()
