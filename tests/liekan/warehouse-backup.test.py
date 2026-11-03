"""Configuration portability and isolation without Docker or a database."""
import importlib.util
import copy
import json
import pathlib
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('warehouse_backup', pathlib.Path(__file__).resolve().parents[2] / 'scripts/liekan-warehouse-backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class ConfigurationBackupTest(unittest.TestCase):
    def test_compose_shell_expansion_is_decoded_only_once(self):
        config = {'services': {'ch': {
            'healthcheck': {'test': ['CMD-SHELL', 'check "$${USER}"; echo $$$$']},
            'command': ['sh', '-c', 'echo $${NAME}'],
        }}}
        literal = backup.compose_literals(config)
        self.assertEqual(literal['services']['ch']['healthcheck']['test'][1], 'check "${USER}"; echo $$')
        self.assertEqual(literal['services']['ch']['command'][2], 'echo ${NAME}')
        self.assertEqual(backup.backup_configuration(literal, 'literal-v1'), literal)

    def test_early_archive_commands_decode_without_changing_literal_credentials(self):
        config = {'services': {'ch': {
            'healthcheck': {'test': ['CMD-SHELL', 'check "$${USER}"']},
            'environment': {'PASSWORD': 'synthetic$$literal$secret'},
        }}}
        decoded = backup.backup_configuration(config, None)
        self.assertEqual(decoded['services']['ch']['healthcheck']['test'][1], 'check "${USER}"')
        self.assertEqual(decoded['services']['ch']['environment']['PASSWORD'], 'synthetic$$literal$secret')

    def test_unknown_configuration_encoding_is_rejected(self):
        with self.assertRaises(RuntimeError):
            backup.backup_configuration({'services': {}}, 'future-encoding')

    def test_copied_config_survives_source_removal_and_backup_relocation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source = root / 'original.xml'
            source.write_text('<clickhouse>original configuration</clickhouse>')
            destination = root / 'backup'
            destination.mkdir()
            config = {'services': {name: {'volumes': [{'type': 'bind', 'source': str(source), 'target': '/config.xml', 'read_only': True}]} for name in ['ch', 'worker']}}
            files = backup.capture_file_mounts(config, destination)
            self.assertEqual(len(files), 1)
            self.assertEqual((destination / 'bind-config').stat().st_mode & 0o777, 0o700)
            self.assertEqual((destination / next(iter(files))).stat().st_mode & 0o777, 0o644)
            # An early archive must remain restartable with its original image.
            (destination / next(iter(files))).chmod(0o444)
            source.unlink()
            relocated = root / 'relocated'
            destination.rename(relocated)
            backup.restore_file_mounts(config, relocated, files)
            for service in config['services'].values():
                self.assertEqual(pathlib.Path(service['volumes'][0]['source']).read_text(), '<clickhouse>original configuration</clickhouse>')
                self.assertEqual(pathlib.Path(service['volumes'][0]['source']).stat().st_mode & 0o777, 0o644)
                self.assertTrue(service['volumes'][0]['read_only'])

    def test_no_writable_or_unverified_host_mount_can_survive_restore(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            for source in ['/original-production/file', '../outside', './bind-config/' + 'a' * 64]:
                config = {'services': {'ch': {'volumes': [{'type': 'bind', 'source': source, 'read_only': True}]}}}
                with self.assertRaises(RuntimeError):
                    backup.restore_file_mounts(config, root, set())
            valid = './bind-config/' + 'a' * 64
            with self.assertRaises(RuntimeError):
                backup.restore_file_mounts({'services': {'ch': {'volumes': [{'type': 'bind', 'source': valid, 'read_only': False}]}}}, root, {valid[2:]})

    def test_mutable_data_mount_is_not_silently_omitted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            file = root / 'config'
            file.write_text('configuration')
            for source, readonly in [(file, False), (root, True)]:
                with self.assertRaises(RuntimeError):
                    backup.capture_file_mounts({'services': {'ch': {'volumes': [{'type': 'bind', 'source': str(source), 'read_only': readonly}]}}}, root)

    def test_migration_archives_are_part_of_the_consistent_backup(self):
        self.assertIn('liekan-warehouse-backups', backup.VOLUMES)

    def test_restore_does_not_launch_an_uncaptured_installer(self):
        config = {'services': {
            'warehouse-init': {'image': 'mutable-application-tag'},
            'app': {'depends_on': {'warehouse-init': {'condition': 'service_completed_successfully'}, 'db': {'condition': 'service_healthy'}}},
            'worker': {'depends_on': ['warehouse-init', 'app']},
        }}
        backup.remove_restore_installer(config)
        self.assertNotIn('warehouse-init', config['services'])
        self.assertEqual(config['services']['app']['depends_on'], {'db': {'condition': 'service_healthy'}})
        self.assertEqual(config['services']['worker']['depends_on'], ['app'])

    def test_changed_compose_cannot_select_an_unused_volume(self):
        configured = {'volumes': [{'type': 'volume', 'source': 'liekan-data', 'target': '/data'}]}
        actual = [{'Type': 'volume', 'Name': 'original-db', 'Destination': '/data', 'RW': True}]
        backup.verify_running_mounts('db', configured, actual, {'liekan-data': {'name': 'original-db'}})
        with self.assertRaises(RuntimeError):
            backup.verify_running_mounts('db', configured, actual, {'liekan-data': {'name': 'unused-db'}})

    def test_extra_data_mount_is_rejected_but_disposable_redis_cache_is_allowed(self):
        actual = [{'Type': 'volume', 'Name': 'anonymous', 'Destination': '/data', 'RW': True}]
        with self.assertRaises(RuntimeError):
            backup.verify_running_mounts('db', {}, actual, {})
        backup.verify_running_mounts('analytics-cache', {}, actual, {})

    def test_recovery_blocks_provider_egress_on_every_network(self):
        config = {'services': {'log-worker': {
            'environment': {'PROVIDER_KEY': 'synthetic$credential'},
            'networks': {'default': {}, 'extra': {}},
        }}, 'networks': {
            'default': {'name': 'original', 'ipam': {'config': [{'subnet': '10.1.0.0/16'}]}},
            'extra': {'driver': 'bridge', 'driver_opts': {'com.docker.network.bridge.name': 'original-bridge'}},
        }}
        backup.recovery_networks(config, 'restored')
        for key, network in config['networks'].items():
            self.assertTrue(network['internal'])
            self.assertEqual(network['name'], f'restored_{key}')
            self.assertNotIn('ipam', network)
            self.assertNotIn('driver_opts', network)
        # Preserve the captured secrets for a deliberate disaster-recovery
        # takeover, while making them unable to reach a provider during testing.
        self.assertEqual(config['services']['log-worker']['environment']['PROVIDER_KEY'], 'synthetic$credential')

    def test_recovery_cannot_keep_an_external_host_or_macvlan_network(self):
        for config in [
            {'services': {}, 'networks': {'default': {'external': True}}},
            {'services': {}, 'networks': {'default': {'driver': 'macvlan'}}},
            {'services': {'app': {'network_mode': 'host'}}},
            {'services': {'app': {'external_links': ['production:provider']}}},
        ]:
            with self.assertRaises(RuntimeError):
                backup.recovery_networks(config, 'restored')
        implicit = {'services': {'app': {}}}
        backup.recovery_networks(implicit, 'restored')
        self.assertTrue(implicit['networks']['default']['internal'])

    def test_activation_requires_explicit_takeover_before_accessing_docker(self):
        with patch.object(backup, 'run') as docker:
            with self.assertRaisesRegex(RuntimeError, 'confirm-takeover'):
                backup.activate(SimpleNamespace(confirm_takeover=False))
            docker.assert_not_called()

    def activation_fixture(self, directory):
        config = {
            'services': {'app': {'image': 'sha256:saved', 'environment': {'KEY': 'synthetic$$secret'}}},
            'volumes': {key: {'name': f'restored_{key}'} for key in backup.VOLUMES},
            'networks': {'default': {'name': 'restored_default', 'internal': True}},
        }
        (directory / 'restore-restored.compose.json').write_text(json.dumps(config))
        (directory / 'restore-restored.json').write_text(json.dumps({
            'project': 'restored', 'externalWrites': 'isolated',
            'volumes': {key: f'restored_{key}' for key in backup.VOLUMES},
        }))
        return config, SimpleNamespace(directory=directory, project='restored', confirm_takeover=True)

    def test_activation_only_prepares_new_networks_for_stopped_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            config, args = self.activation_fixture(directory)
            before = copy.deepcopy(config)
            def docker(command, capture=False):
                if command[-3:] == ['config', '--format', 'json']: return json.dumps(config)
                if command[-3:] == ['ps', '--all', '--quiet']: return 'restored-app\n'
                if command == ['docker', 'inspect', 'restored-app']:
                    return json.dumps([{'State': {'Running': False}}])
                self.fail(f'Activation attempted a mutation: {command}')
            with patch.object(backup, 'run', side_effect=docker):
                backup.activate(args)
            activated = json.loads((directory / 'active-restored.compose.json').read_text())
            self.assertFalse(activated['networks']['default']['internal'])
            self.assertEqual(activated['networks']['default']['name'], 'restored_active_default')
            self.assertEqual(activated['volumes'], before['volumes'])
            self.assertEqual(activated['services'], before['services'])
            self.assertEqual(json.loads((directory / 'restore-restored.compose.json').read_text()), before)

    def test_activation_refuses_running_or_shared_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            config, args = self.activation_fixture(directory)
            def docker(command, capture=False):
                if command[-3:] == ['config', '--format', 'json']: return json.dumps(config)
                if command[-3:] == ['ps', '--all', '--quiet']: return 'restored-app'
                if command == ['docker', 'inspect', 'restored-app']:
                    return json.dumps([{'State': {'Running': True}}])
                self.fail(f'Unexpected Docker call: {command}')
            with patch.object(backup, 'run', side_effect=docker):
                with self.assertRaisesRegex(RuntimeError, 'Stop all restored'):
                    backup.activate(args)
                config['volumes']['liekan-data']['name'] = 'original_liekan-data'
                with self.assertRaisesRegex(RuntimeError, 'shared or changed'):
                    backup.activate(args)
            self.assertFalse((directory / 'active-restored.compose.json').exists())


if __name__ == '__main__':
    unittest.main()
