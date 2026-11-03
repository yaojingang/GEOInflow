"""Storage configuration preflight; no Docker service or database is started."""
import importlib.util
import json
import pathlib
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('warehouse_deploy', pathlib.Path(__file__).resolve().parents[2] / 'scripts/liekan-warehouse-deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DependencyConfigurationTest(unittest.TestCase):
    def test_changed_ch_or_queue_configuration_stops_before_any_service_mutation(self):
        names = ['db', 'analytics-cache', 'warehouse-ch', 'warehouse-queue']
        config = {'services': {name: {} for name in names}}
        for changed in ['warehouse-ch', 'warehouse-queue']:
            def compose(*args, **kwargs):
                if args[:3] == ('ps', '--all', '--quiet'): return args[3] + '-original'
                if args[:2] == ('config', '--hash'):
                    return args[2] + ' ' + ('b' if args[2] == changed else 'a') * 64 + '\n'
                self.fail(f'Preflight mutated a service: {args}')
            def inspect(command, **kwargs):
                self.assertEqual(command[:2], ['docker', 'inspect'])
                return json.dumps([{'Config': {'Labels': {'com.docker.compose.config-hash': 'a' * 64}}}])
            with patch.object(deploy, 'compose', side_effect=compose), patch.object(deploy.subprocess, 'check_output', side_effect=inspect), patch.object(deploy.subprocess, 'run') as start:
                with self.assertRaisesRegex(RuntimeError, changed + ' runtime configuration differs'):
                    deploy.dependency_plan(config, names)
                start.assert_not_called()

    def test_original_postgres_container_never_reconciles_to_new_major(self):
        config = {'services': {'db': {'image': 'postgres:new-major'}}}
        with patch.object(deploy, 'compose', return_value='original-pg\n') as compose, patch.object(deploy.subprocess, 'check_output') as inspect:
            plan = deploy.dependency_plan(config, ['db'])
            self.assertEqual(plan, [('db', 'original-pg')])
            compose.assert_called_once_with('ps', '--all', '--quiet', 'db', capture=True)
            inspect.assert_not_called()
        healthy = json.dumps([{'State': {'Running': True, 'Health': {'Status': 'healthy'}}}])
        with patch.object(deploy.subprocess, 'run') as start, patch.object(deploy.subprocess, 'check_output', return_value=healthy), patch.object(deploy, 'compose') as compose:
            deploy.dependencies(plan)
            self.assertEqual(start.call_args.args[0], ['docker', 'start', 'original-pg'])
            compose.assert_not_called()

    def test_matching_storage_config_can_start_its_original_container(self):
        def compose(*args, **kwargs):
            if args[0] == 'ps': return 'original-ch'
            return 'warehouse-ch ' + 'a' * 64
        info = json.dumps([{'Config': {'Labels': {'com.docker.compose.config-hash': 'a' * 64}}}])
        with patch.object(deploy, 'compose', side_effect=compose), patch.object(deploy.subprocess, 'check_output', return_value=info):
            self.assertEqual(deploy.dependency_plan({'services': {'warehouse-ch': {}}}, ['warehouse-ch']), [('warehouse-ch', 'original-ch')])

    def test_unknown_hash_does_not_claim_configuration_was_applied(self):
        for output, labels in [('unexpected-output', {}), ('warehouse-ch ' + 'a' * 64, {})]:
            with patch.object(deploy, 'compose', side_effect=['original-ch', output]), patch.object(deploy.subprocess, 'check_output', return_value=json.dumps([{'Config': {'Labels': labels}}])):
                with self.assertRaises(RuntimeError):
                    deploy.dependency_plan({'services': {'warehouse-ch': {}}}, ['warehouse-ch'])

    def test_existing_volume_without_container_requires_original_engine(self):
        config = {'services': {'warehouse-ch': {'volumes': [{'type': 'volume', 'source': 'facts'}]}}, 'volumes': {'facts': {'name': 'original-facts'}}}
        with patch.object(deploy, 'compose', return_value=''), patch.object(deploy.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
            with self.assertRaisesRegex(RuntimeError, 'original image'):
                deploy.dependency_plan(config, ['warehouse-ch'])


if __name__ == '__main__':
    unittest.main()
