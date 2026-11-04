"""Same-host orchestration guards; unit tests never contact production or start Docker."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('warehouse_test', ROOT / 'scripts/liekan-warehouse-test.py')
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


def source():
    db = {'Id': 'd' * 64, 'Name': '/prod-db-1', 'State': {'Running': True}, 'Mounts': [],
          'Config': {'Labels': {'com.docker.compose.project': 'prod', 'com.docker.compose.service': 'db'},
                     'Env': ['POSTGRES_USER=u', 'POSTGRES_PASSWORD=p', 'POSTGRES_DB=stats']},
          'NetworkSettings': {'Networks': {'prod_default': {'Aliases': ['db'], 'IPAddress': '10.0.0.2'}}}}
    app = copy.deepcopy(db)
    app.update(Id='a' * 64, Name='/prod-app-1')
    app['Config'] = {'Labels': {'com.docker.compose.project': 'prod', 'com.docker.compose.service': 'app',
                              'com.docker.compose.project.working_dir': '/different/production'},
                     'Env': ['DATABASE_URL=postgresql://u:p@db:5432/stats', 'APP_SECRET=secret', 'TWO_FACTOR_ENCRYPTION_KEY=key']}
    return app, db


def model():
    project, run = 'geoinflow-test-unit', 'owned-run'
    env = {'DATABASE_URL': 'postgresql://u:p@db:5432/stats', 'LIEKAN_CLICKHOUSE_URL': 'http://warehouse-ch:8123',
           'LIEKAN_QUEUE_BROKERS': 'warehouse-queue:9092'}
    services = {s: {'labels': {w.LABEL: run}, 'networks': {'default': {}}, 'environment': dict(env),
                    'image': 'test:image'} for s in w.SERVICES}
    services['db']['environment'] = {'POSTGRES_USER': 'u', 'POSTGRES_PASSWORD': 'p', 'POSTGRES_DB': 'stats'}
    return {'name': project, 'services': services,
            'networks': {'default': {'name': project + '_default', 'internal': True, 'enable_ipv6': False,
                                     'driver_opts': dict(w.NETWORK_OPTIONS)}},
            'volumes': {'data': {'name': project + '_data', 'labels': {w.LABEL: run}}}}


class SourceGuard(unittest.TestCase):
    def check_pair(self, app, db, project='geoinflow-test-unit'):
        with patch.object(w, 'inspect', side_effect=[app, db]):
            return w.source_pair('app', 'db', project)

    def test_correct_source_pair(self):
        a, d = source()
        self.assertEqual(self.check_pair(a, d), (a, d))

    def test_wrong_project_service_or_stopped_source(self):
        for mutate in [lambda a, d: d['Config']['Labels'].update({'com.docker.compose.project': 'other'}),
                       lambda a, d: a['Config']['Labels'].update({'com.docker.compose.service': 'worker'}),
                       lambda a, d: d['State'].update(Running=False)]:
            a, d = source(); mutate(a, d)
            with self.assertRaises(w.Refused): self.check_pair(a, d)

    def test_app_database_must_match_actual_selected_db(self):
        for url in ['postgresql://u:p@production.example:5432/stats', 'postgresql://u:p@db:5432/other',
                    'postgresql://u:wrong@db:5432/stats', 'postgresql://u:p@db:6543/stats',
                    'postgresql://u:p@db:5432/stats?host=other-production-db']:
            a, d = source(); a['Config']['Env'][0] = 'DATABASE_URL=' + url
            with self.assertRaises(w.Refused): self.check_pair(a, d)

    def test_production_checkout_and_bind_parent_refused(self):
        a, d = source(); a['Config']['Labels']['com.docker.compose.project.working_dir'] = str(w.ROOT)
        with self.assertRaises(w.Refused): self.check_pair(a, d)
        a, d = source(); d['Mounts'] = [{'Type': 'bind', 'Source': str(w.ROOT.parent)}]
        with self.assertRaises(w.Refused): self.check_pair(a, d)

    def test_source_warehouse_and_newer_pg_are_refused(self):
        for results in [['180000'], ['160000', 't', '1']]:
            with patch.object(w, 'source_sql', side_effect=results), self.assertRaises(w.Refused):
                w.source_metadata({})

    def test_source_commands_are_read_only_and_use_pinned_container(self):
        with patch.object(w, 'docker', return_value=b'16\n') as d:
            self.assertEqual(w.source_sql({'Id': 'pinned-source'}, 'SELECT 16;'), '16')
            args = d.call_args.args
            self.assertEqual(args[0], 'exec')
            self.assertIn('pinned-source', args)
            self.assertIn('default_transaction_read_only=on', args[3])
            self.assertEqual(d.call_args.kwargs['data'], b'SELECT 16;')


class ModelGuard(unittest.TestCase):
    def validate(self, c):
        w.validate_model(c, 'geoinflow-test-unit', 'owned-run', 'test:image')

    def test_valid_isolated_model(self): self.validate(model())

    def test_ports_external_volumes_foreign_image_and_connections(self):
        mutations = [lambda c: c['services']['app'].update(ports=[{'published': '3002'}]),
                     lambda c: c['services']['app'].update(image='liekan:1.2.0'),
                     lambda c: c['volumes']['data'].update(name='liekan_data'),
                     lambda c: c['volumes']['data'].update(external=True),
                     lambda c: c['volumes']['data'].update(driver_opts={'device': '/production'}),
                     lambda c: c['networks']['default'].update(internal=False),
                     lambda c: c['networks']['default'].update(enable_ipv6=True),
                     lambda c: c['networks']['default'].update(driver_opts={}),
                     lambda c: c['networks']['default'].update(ipam={'config': [{'subnet': '10.253.30.0/24'}]}),
                     lambda c: c['services']['app']['environment'].update(DATABASE_URL='postgresql://production'),
                     lambda c: c['services']['app']['environment'].update(LIEKAN_ANALYTICS_CLICKHOUSE_URL='http://production'),
                     lambda c: c['services']['app'].update(volumes=[{'type': 'bind', 'source': '/var/run/docker.sock', 'target': '/socket'}])]
        for mutate in mutations:
            c = model(); mutate(c)
            with self.assertRaises(w.Refused): self.validate(c)

    def test_environment_never_inherits_production_compose_settings(self):
        with patch.dict(os.environ, {'COMPOSE_PROJECT_NAME': 'production', 'COMPOSE_FILE': 'prod.yml',
                                     'DATABASE_URL': 'secret', 'LIEKAN_CLICKHOUSE_URL': 'production'}):
            env = w.child_env()
            for key in ['COMPOSE_PROJECT_NAME', 'COMPOSE_FILE', 'DATABASE_URL', 'LIEKAN_CLICKHOUSE_URL']:
                self.assertNotIn(key, env)

    def test_literal_dollars_round_trip(self):
        value = {'secret': "a$TOKEN${HOME}'\\double\"$$"}
        self.assertEqual(w.literal(w.literal(value), False), value)

    def test_project_names_reject_production_and_shell_injection(self):
        for name in ['liekan', 'geoinflow-test-../prod', 'geoinflow-test-x;bad', 'geoinflow-test-']:
            with self.assertRaises(w.Refused): w.check_project(name)

    def test_plan_accepts_docker26_without_creating_resources(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = SimpleNamespace(command='plan', project='geoinflow-test-unit', source_app='app', source_db='db', subnet=None)
            stack = w.TestStack(args)
            stack.directory = Path(tmp) / 'uncreated'
            def docker(*args):
                if args[0] == 'version': return b'26.1.4'
                if args[0] in ('volume', 'network', 'ps'): return b''
                self.fail('Plan tried to mutate Docker')
            output = io.StringIO()
            with patch.object(w, 'docker', side_effect=docker), patch.object(w, 'source_pair', return_value=source()), \
                    patch.object(w, 'source_metadata', return_value={'bytes': 100, 'version': 160000}), \
                    patch.object(w.sys, 'stdout', output):
                stack.prepare()
            self.assertEqual(json.loads(output.getvalue())['network_options'],
                             {'com.docker.network.bridge.inhibit_ipv4': 'true'})
            self.assertFalse(stack.directory.exists())

    def test_isolation_selection_rejects_unsupported_engines(self):
        for version in ('26.1.4', '27.5.1'):
            self.assertEqual(w.engine_network_options(version), w.LEGACY_NETWORK_OPTIONS)
        for version in ('28.0.0', '29.2.1'):
            self.assertEqual(w.engine_network_options(version), w.NETWORK_OPTIONS)
        for version in ('25.0.0', '26.0.0', '26.0.1', '26.1.3', '', 'unknown'):
            with self.assertRaises(w.Refused): w.engine_network_options(version)

    def test_legacy_model_requires_exact_frozen_isolation(self):
        c = model();c['networks']['default']['driver_opts'] = dict(w.LEGACY_NETWORK_OPTIONS)
        w.validate_model(c, 'geoinflow-test-unit', 'owned-run', 'test:image', network_options=w.LEGACY_NETWORK_OPTIONS)
        with self.assertRaises(w.Refused): self.validate(c)
        for unsafe in ({}, {'com.docker.network.bridge.inhibit_ipv4': 'false'}):
            c['networks']['default']['driver_opts'] = unsafe
            with self.assertRaises(w.Refused):
                w.validate_model(c, 'geoinflow-test-unit', 'owned-run', 'test:image', network_options=unsafe)


class RuntimeGuard(unittest.TestCase):
    def setUp(self):
        self.stack = object.__new__(w.TestStack)
        self.stack.args = SimpleNamespace(project='geoinflow-test-unit', command='status')
        self.stack.directory = Path('/private/test')
        self.stack.state = {'root': str(w.ROOT), 'project': self.stack.args.project, 'daemon': 'daemon',
                            'run_id': 'owned-run', 'env_sha': 'digest', 'image_id': 'image', 'source_ids': ['source']}
        self.stack.config = model
        self.container = {'Id': 'test', 'Image': 'image', 'Mounts': [], 'HostConfig': {},
                          'Config': {'Labels': {'com.docker.compose.project': self.stack.args.project,
                                                'com.docker.compose.service': 'app', w.LABEL: 'owned-run'},
                                     'Env': [k + '=' + v for k, v in model()['services']['app']['environment'].items()]},
                          'NetworkSettings': {'Networks': {self.stack.args.project + '_default': {}}}}

    def guard(self, container, options=None):
        def docker(*args):
            if args[0] == 'info': return b'"daemon"'
            if args[0] == 'version': return getattr(self, 'engine_version', '26.1.4').encode()
            if args[:2] == ('volume', 'ls'): return b'geoinflow-test-unit_data\n'
            if args[:2] == ('network', 'ls'): return b'geoinflow-test-unit_default\n'
            if args[0] == 'ps': return b'test\n'
            if args[0] == 'inspect': return json.dumps([container]).encode()
            self.fail('Unexpected Docker command')
        def inspect(kind, name):
            if kind == 'network': return {'Labels': {w.LABEL: 'owned-run'}, 'Internal': True, 'Options': w.NETWORK_OPTIONS if options is None else options}
            return {'Labels': {w.LABEL: 'owned-run'}, 'Driver': 'local', 'Options': {}}
        with patch.object(w, 'docker', side_effect=docker), patch.object(w, 'inspect', side_effect=inspect), \
                patch.object(w, 'sha', return_value='digest'):
            return self.stack.guard()

    def test_owned_runtime_passes(self):
        self.assertEqual(self.guard(self.container), [self.container])

    def test_queue_storage_readonly_mount_and_environment_cannot_drift(self):
        config = model()
        path = '/app/warehouse-queue-storage'
        config['services']['app']['volumes'] = [
            {'type': 'volume', 'source': 'data', 'target': path, 'read_only': True}]
        config['services']['app']['environment']['LIEKAN_QUEUE_STORAGE_PATH'] = path
        self.stack.config = lambda: config
        self.container['Config']['Env'].append('LIEKAN_QUEUE_STORAGE_PATH=' + path)
        self.container['Mounts'] = [{'Type': 'volume', 'Name': 'geoinflow-test-unit_data',
                                     'Destination': path, 'RW': False}]
        self.assertEqual(self.guard(self.container), [self.container])
        for mutation in (lambda c: c['Mounts'][0].update(RW=True),
                         lambda c: c.update(Mounts=[]),
                         lambda c: c['Config']['Env'].remove('LIEKAN_QUEUE_STORAGE_PATH=' + path)):
            candidate = copy.deepcopy(self.container)
            mutation(candidate)
            with self.assertRaises(w.Refused): self.guard(candidate)

    def test_unsafe_daemon_downgrade_blocks_run_and_serve_but_allows_recovery(self):
        self.engine_version = '26.0.1'
        for command in ('run', 'serve'):
            self.stack.args.command = command
            with self.assertRaisesRegex(w.Refused, '26.1.4'): self.guard(self.container)
        for command in ('status', 'stop'):
            self.stack.args.command = command
            self.assertEqual(self.guard(self.container), [self.container])

    def test_modern_network_cannot_resume_after_engine_downgrade(self):
        for command in ('run', 'serve'):
            self.stack.args.command = command
            with self.assertRaisesRegex(w.Refused, 'Docker 28'): self.guard(self.container)
        c = model();c['networks']['default']['driver_opts'] = dict(w.LEGACY_NETWORK_OPTIONS)
        self.stack.config = lambda: c
        self.stack.state['network_options'] = dict(w.LEGACY_NETWORK_OPTIONS)
        self.stack.args.command = 'serve'
        self.assertEqual(self.guard(self.container, w.LEGACY_NETWORK_OPTIONS), [self.container])
        self.engine_version = '29.2.1'
        self.assertEqual(self.guard(self.container, w.LEGACY_NETWORK_OPTIONS), [self.container])

    def test_runtime_network_must_match_the_frozen_legacy_mode(self):
        c = model();c['networks']['default']['driver_opts'] = dict(w.LEGACY_NETWORK_OPTIONS)
        self.stack.config = lambda: c
        self.assertEqual(self.guard(self.container, w.LEGACY_NETWORK_OPTIONS), [self.container])
        for different in ({}, w.NETWORK_OPTIONS, {'com.docker.network.bridge.inhibit_ipv4': 'false'}):
            with self.assertRaises(w.Refused): self.guard(self.container, different)

    def test_foreign_attachments_and_connection_drift_refused(self):
        mutations = [lambda c: c['Config']['Labels'].update({w.LABEL: 'foreign'}),
                     lambda c: c['Config']['Env'].append('DATABASE_URL=postgresql://production'),
                     lambda c: c['NetworkSettings']['Networks'].update(production={}),
                     lambda c: c['HostConfig'].update(PortBindings={'3000/tcp': [{'HostPort': '3002'}]}),
                     lambda c: c.update(Image='wrong'),
                     lambda c: c['Config']['Labels'].update({'com.docker.compose.project': 'foreign'})]
        for mutate in mutations:
            c = copy.deepcopy(self.container); mutate(c)
            with self.assertRaises(w.Refused): self.guard(c)

    def test_foreign_volume_sharer_is_refused(self):
        c = copy.deepcopy(self.container)
        c['Config']['Labels']['com.docker.compose.project'] = 'foreign'
        c['NetworkSettings']['Networks'] = {}
        c['Mounts'] = [{'Type': 'volume', 'Name': 'geoinflow-test-unit_data'}]
        with self.assertRaises(w.Refused): self.guard(c)

    def test_storage_cleanup_skips_source_drift_but_keeps_ownership_guards(self):
        self.engine_version = '29.2.1'
        self.stack.args.command = 'check-storage'
        self.stack.state['signature'] = {'source': 'old'}
        with patch.object(w, 'source_signature', return_value={'source': 'new'}):
            with self.assertRaisesRegex(w.Refused, 'source changed'):
                self.guard(self.container)
            original_guard = self.stack.guard
            self.stack.guard = lambda: original_guard(recovery=True)
            self.assertEqual(self.guard(self.container), [self.container])
            self.container['Config']['Labels'][w.LABEL] = 'foreign'
            with self.assertRaises(w.Refused): self.guard(self.container)


class ResumeAndDiagnostics(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.stack = object.__new__(w.TestStack)
        self.stack.directory = Path(self.temp.name)
        self.stack.state = {'done': {}}
        self.stack.args = SimpleNamespace(wait_seconds=60)
        self.stack.guard = lambda: []
        self.stack.save = lambda: None

    def test_retry_understands_cli_stdout_error(self):
        calls = []
        def wh(*args, **kw):
            calls.append(args)
            if len(calls) == 1:
                kw['output'].write(b'{"error":"warehouse-transition-input-not-drained"}\n')
                raise w.Failed()
            kw['output'].write(b'{"status":"frozen"}\n')
        self.stack.wh = wh
        with patch.object(w.time, 'sleep'):
            result = self.stack.warehouse_step('freeze', ['freeze', '--operation', 'same-id'], retry=True)
        self.assertEqual(result['status'], 'frozen')
        self.assertEqual(calls[0], calls[1])

    def test_error_json_is_never_adopted_as_archive(self):
        (self.stack.directory / 'archive.jsonl').write_text('{"error":"warehouse-postgres-tool-failed"}\n')
        self.stack.state['pending'] = 'archive'
        self.stack.wh = lambda *a, **k: self.fail('Must not repeat an uncertain archive')
        with self.assertRaisesRegex(w.Refused, 'uncertain'):
            self.stack.warehouse_step('archive', ['snapshot-export'], uncertain=True)
        self.assertNotIn('archive', self.stack.state['done'])

    def test_complete_archive_receipt_recovers_lost_response(self):
        value = {'sha256': 'a' * 64, 'directory': '/app/warehouse-backups/snapshot_abc',
                 'archive': '/app/warehouse-backups/snapshot_abc/source.dump', 'boundary': {}}
        (self.stack.directory / 'archive.jsonl').write_text(json.dumps(value) + '\n')
        self.stack.state['pending'] = 'archive'
        self.stack.wh = lambda *a, **k: self.fail('Must not duplicate archive')
        self.assertEqual(self.stack.warehouse_step('archive', ['snapshot-export'], uncertain=True), value)

    def test_unknown_failure_is_not_retried(self):
        def wh(*a, **kw):
            kw['output'].write(b'{"error":"warehouse-baseline-conflict"}\n')
            raise w.Failed()
        self.stack.wh = wh
        with patch.object(w.time, 'sleep') as sleep, self.assertRaises(w.Failed):
            self.stack.warehouse_step('freeze', ['freeze'], retry=True)
        sleep.assert_not_called()

    def test_command_failure_redacts_raw_stderr_and_stdout(self):
        with self.assertRaises(w.Failed) as error:
            w.command([sys.executable, '-c', 'import sys; print("secret://private"); print("raw visitor data",file=sys.stderr); sys.exit(1)'])
        self.assertEqual(str(error.exception), 'command-failed')
        with self.assertRaises(w.Failed) as error:
            w.command([sys.executable, '-c', 'import sys; print("{\\"error\\":\\"warehouse-transition-input-not-drained\\"}"); sys.exit(1)'])
        self.assertEqual(error.exception.code, 'warehouse-transition-input-not-drained')

    def test_stop_uses_only_guarded_ids_not_source_names(self):
        self.stack.guard = lambda: [{'Id': 'test-a'}, {'Id': 'test-b'}]
        with patch.object(w, 'docker') as d:
            self.stack.stop()
        d.assert_called_once_with('stop', '--time', '120', 'test-a', 'test-b')

    def test_interrupted_backups_reuse_one_owned_partial(self):
        self.stack.state['source_db'] = 'source'
        def interrupted(*args, **kw):
            kw['output'].write(b'incomplete dump')
            raise w.Failed()
        with patch.object(w, 'inspect', return_value={'Id': 'source'}), \
                patch.object(w, 'source_metadata'), patch.object(w, 'docker', side_effect=interrupted):
            for _ in range(3):
                with self.assertRaises(w.Failed): self.stack.backup()
        self.assertEqual([p.name for p in self.stack.directory.iterdir()], ['source.dump.partial'])
        self.assertEqual((self.stack.directory / 'source.dump.partial').read_bytes(), b'incomplete dump')

    def test_existing_backup_is_verified_without_contacting_source(self):
        target = self.stack.directory / 'source.dump'; target.write_bytes(b'complete')
        receipt = {'sha256': w.sha(target), 'bytes': 8}
        (self.stack.directory / 'backup.json').write_text(json.dumps(receipt))
        with patch.object(w, 'docker') as docker:
            self.assertEqual(self.stack.backup(), receipt)
        docker.assert_not_called()

    def test_stopped_deployed_stack_restarts_without_reinitializing(self):
        self.stack.args.until = 'deploy'
        self.stack.state.update(image='tag', image_id='id')
        self.stack.state['done'] = dict.fromkeys(['backup', 'image', 'restore', 'ledger', 'deploy'], True)
        started = []
        self.stack.up = lambda services: started.extend(services)
        self.stack.status = lambda: None
        with patch.object(w, 'inspect', return_value={'Id': 'id'}):
            self.stack.run()
        self.assertEqual(set(started), w.SERVICES - {'warehouse-init'})

    def test_state_is_loaded_only_after_controller_lock(self):
        with patch.object(w, 'ROOT', self.stack.directory), \
                patch.object(w.sys, 'argv', ['test', 'status', '--project', 'geoinflow-test-lock']), \
                patch.object(w.fcntl, 'flock') as lock, patch.object(w, 'TestStack') as cls:
            def construct(args):
                lock.assert_called_once()
                result = SimpleNamespace(state={'done': {}}, status=lambda: None)
                return result
            cls.side_effect = construct
            w.main()

    def test_restore_nonempty_without_matching_receipt_refuses(self):
        backup = self.stack.directory / 'source.dump'; backup.write_bytes(b'dump')
        self.stack.state.update(run_id='r', done={'backup': {'sha256': w.sha(backup)}})
        self.stack.sql = lambda sql: 'f' if 'to_regclass' in sql else '1'
        with self.assertRaisesRegex(w.Refused, 'not empty'), patch.object(w.subprocess, 'Popen') as p:
            self.stack.restore()
        p.assert_not_called()

    def test_restore_matching_atomic_receipt_is_not_reimported(self):
        backup = self.stack.directory / 'source.dump'; backup.write_bytes(b'dump')
        digest = w.sha(backup)
        self.stack.state.update(run_id='r', done={'backup': {'sha256': digest}})
        self.stack.sql = lambda sql: 't' if 'to_regclass' in sql else 'r\t' + digest
        with patch.object(w.subprocess, 'Popen') as p:
            self.assertEqual(self.stack.restore(), {'sha256': digest})
        p.assert_not_called()


class ImageRefresh(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stack = object.__new__(w.TestStack)
        self.stack.args = SimpleNamespace(project='geoinflow-test-unit', command='refresh-images',
                                         clickhouse_image=None, queue_image=None)
        self.stack.directory = self.root
        self.stack.state_path = self.root / 'state.json'
        self.stack.config_path = self.root / 'compose.json'
        self.original = model()
        self.original['services']['warehouse-ch']['image'] = 'ch:old'
        self.original['services']['warehouse-queue']['image'] = 'queue:old'
        self.rendered = copy.deepcopy(self.original)
        for service, digest in w.IMAGE_DIGESTS.items():
            self.rendered['services'][service]['image'] = 'official/' + service + '@' + digest
        self.stack.config = lambda: copy.deepcopy(self.original)
        self.stack.guard = lambda: []
        self.stack.render_existing_config = lambda: copy.deepcopy(self.rendered)
        self.signature = {'scripts/liekan-warehouse-test.py': 'new-script',
                          'docker-compose.warehouse.yml': 'new-compose', 'migrations': 'same'}
        dump = self.root / 'source.dump'; dump.write_bytes(b'synthetic backup')
        self.receipt = {'sha256': w.sha(dump), 'bytes': dump.stat().st_size, 'source_container': 'source'}
        w.atomic(self.root / 'backup.json', self.receipt)
        w.atomic(self.stack.config_path, w.literal(self.original))
        self.stack.state = {'done': {'backup': self.receipt}, 'source_db': 'source', 'run_id': 'owned-run',
                            'signature': dict(self.signature, **{'scripts/liekan-warehouse-test.py': 'old-script'}),
                            'image': 'test:image', 'config_sha': w.sha(self.stack.config_path)}
        w.atomic(self.stack.state_path, self.stack.state)
        self.source_state = self.stack.state_path.read_bytes()
        self.source_config = self.stack.config_path.read_bytes()

    def refresh(self, listing=b''):
        def docker(*args):
            if args[:2] in [('volume', 'ls'), ('network', 'ls'), ('image', 'ls')]:
                return listing
            self.fail('Refresh attempted a Docker mutation')
        with patch.object(w, 'source_signature', return_value=self.signature), \
                patch.object(w, 'docker', side_effect=docker), \
                patch.object(w, 'inspect', side_effect=lambda kind, ref: {'RepoDigests': [ref]}):
            self.stack.refresh_images()

    def test_refresh_retains_backup_and_original_config_then_commits_pointer(self):
        self.stack.args.clickhouse_image = 'mirror.example/ch@' + w.IMAGE_DIGESTS['warehouse-ch']
        self.refresh()
        state = json.loads(self.stack.state_path.read_text())
        self.assertEqual(state['done'], {'backup': self.receipt})
        self.assertEqual((self.root / 'compose.json').read_bytes(), self.source_config)
        self.assertEqual(w.sha(self.root / 'source.dump'), self.receipt['sha256'])
        self.assertEqual(state['config_sha'], w.sha(self.root / state['config_file']))
        actual = w.literal(json.loads(self.stack.config_path.read_text()), False)
        self.assertEqual(actual['services']['warehouse-ch']['image'], self.stack.args.clickhouse_image)
        self.original = actual
        self.refresh()
        self.assertEqual(len(self.stack.state['image_refreshes']), 1)

    def test_refresh_rejects_resources_or_later_stages(self):
        with self.assertRaises(w.Refused): self.refresh(b'geoinflow-test-unit_data')
        for key in ('image', 'restore', 'deploy'):
            self.stack.state['done'][key] = True
            with self.assertRaises(w.Refused): self.refresh()
            del self.stack.state['done'][key]
        self.stack.guard = lambda: [{'Id': 'owned-container'}]
        with self.assertRaises(w.Refused): self.refresh()
        self.assertEqual(self.stack.state_path.read_bytes(), self.source_state)

    def test_refresh_rejects_modified_archive_receipt_or_source(self):
        (self.root / 'source.dump').write_bytes(b'changed')
        with self.assertRaises(w.Refused): self.refresh()
        (self.root / 'source.dump').write_bytes(b'synthetic backup')
        self.signature['migrations'] = 'changed'
        with self.assertRaises(w.Refused): self.refresh()
        self.assertEqual(self.stack.state_path.read_bytes(), self.source_state)

    def test_refresh_rejects_non_image_configuration_changes(self):
        for change in [lambda c: c['services']['app']['environment'].update(APP_SECRET='changed'),
                       lambda c: c['services']['app'].update(ports=[{'published': 3002}]),
                       lambda c: c['networks']['default'].update(internal=False),
                       lambda c: c['services']['warehouse-queue'].update(command=['different'])]:
            before = copy.deepcopy(self.rendered)
            change(self.rendered)
            with self.assertRaises(w.Refused): self.refresh()
            self.rendered = before
        self.assertEqual(self.stack.state_path.read_bytes(), self.source_state)

    def test_refresh_requires_approved_digest_and_downloaded_image(self):
        for ref in ('ch:latest', 'ch@sha256:' + 'a' * 64):
            self.stack.args.clickhouse_image = ref
            with self.assertRaises(w.Refused): self.refresh()
        self.stack.args.clickhouse_image = None
        with patch.object(w, 'source_signature', return_value=self.signature), \
                patch.object(w, 'docker', return_value=b''), \
                patch.object(w, 'inspect', return_value={'RepoDigests': []}), self.assertRaises(w.Refused):
            self.stack.refresh_images()

    def test_interrupted_pointer_write_preserves_previous_pair_and_can_retry(self):
        real_atomic = w.atomic
        def interrupted(path, value):
            if Path(path) == self.stack.state_path: raise OSError('synthetic interrupted commit')
            real_atomic(path, value)
        with patch.object(w, 'atomic', side_effect=interrupted), self.assertRaises(OSError):
            self.refresh()
        self.assertEqual(self.stack.state_path.read_bytes(), self.source_state)
        self.assertEqual((self.root / 'compose.json').read_bytes(), self.source_config)
        self.refresh()
        self.assertIn('config_file', json.loads(self.stack.state_path.read_text()))

    def test_configuration_pointer_rejects_paths_outside_run(self):
        project = 'geoinflow-test-pointer'
        directory = self.root / '.local' / project; directory.mkdir(parents=True)
        for filename in ('../production.json', '/tmp/config.json', 'compose.images-../../prod.json'):
            w.atomic(directory / 'state.json', {'config_file': filename})
            with patch.object(w, 'ROOT', self.root), self.assertRaises(w.Refused):
                w.TestStack(SimpleNamespace(project=project))

    def test_storage_probe_stops_only_guarded_ch_queue_on_success_and_failure(self):
        for failure in (False, True):
            owned = [{'Id': name + '-id', 'Config': {'Labels': {'com.docker.compose.service': name}}}
                     for name in ('warehouse-ch', 'warehouse-queue', 'app')]
            self.stack.guard = lambda **kwargs: owned
            def up(names):
                self.assertEqual(set(names), {'warehouse-ch', 'warehouse-queue'})
                if failure: raise w.Refused('synthetic unhealthy')
            self.stack.up = up
            with patch.object(w, 'docker') as docker:
                if failure:
                    with self.assertRaises(w.Refused): self.stack.check_storage()
                else: self.stack.check_storage()
                docker.assert_called_once_with('stop', '--time', '30', 'warehouse-ch-id', 'warehouse-queue-id')


if __name__ == '__main__': unittest.main()
