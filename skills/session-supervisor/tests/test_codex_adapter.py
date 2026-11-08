import pathlib, sys, tempfile, unittest, os
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from codex_adapter import CodexAdapter, wake_decision


def ready(**overrides):
    values = dict(now=100, reset_at=100, temporary_limit_confirmed=True,
                  terminal_turn_confirmed=True, wake_delivery_state='not_sent', user_authorized=True,
                  account_limit_cleared=True, desktop_state='idle',
                  goal_state='active', approval_pending=False,
                  queued_input=False, atomic_host_available=True)
    values.update(overrides)
    return wake_decision(**values)


class WakeDecisionTests(unittest.TestCase):
    def test_only_per_session_authorized_definitive_limit_can_wait(self):
        self.assertEqual(ready(user_authorized=False)['action'], 'stop')
        self.assertEqual(ready(temporary_limit_confirmed=False)['action'], 'stop')
        self.assertEqual(ready(terminal_turn_confirmed=False)['action'], 'hold')
        self.assertEqual(ready(wake_delivery_state='accepted')['action'], 'stop')
        for state in ('unknown', 'in_flight', None):
            with self.subTest(wake_delivery_state=state):self.assertEqual(ready(wake_delivery_state=state)['action'], 'hold')
        self.assertEqual(ready(reset_at=None)['action'], 'stop')
        self.assertEqual(ready(now=99), {'action':'wait','retry_at':100.0,'reason':'provider reset not reached'})
    def test_pending_or_unknown_gates_block_even_after_reset(self):
        for values in ({'account_limit_cleared':None}, {'account_limit_cleared':False},
                       {'desktop_state':'working'}, {'desktop_state':'unknown'}, {'desktop_state':None},
                       {'goal_state':'paused'}, {'goal_state':'blocked'}, {'goal_state':'budgetLimited'},
                       {'goal_state':'usageLimited'}, {'goal_state':None},
                       {'approval_pending':True}, {'approval_pending':None},
                       {'queued_input':True}, {'queued_input':None}, {'atomic_host_available':False}):
            with self.subTest(values=values):self.assertEqual(ready(**values)['action'], 'hold')
    def test_ready_is_only_host_handoff_not_a_dispatch(self):
        self.assertEqual(ready()['action'], 'host_handoff_only')
        self.assertEqual(ready(goal_state='none')['action'], 'host_handoff_only')
        self.assertEqual(ready(wake_delivery_state='confirmed_not_accepted')['action'], 'host_handoff_only')
        self.assertNotIn('send', ready())
    def test_values_are_strict(self):
        for values in ({'now':float('nan')}, {'reset_at':-1}, {'now':True},
                       {'temporary_limit_confirmed':'yes'}, {'terminal_turn_confirmed':1}, {'user_authorized':1},
                       {'queued_input':0}, {'atomic_host_available':None}):
            with self.subTest(values=values), self.assertRaises((TypeError, ValueError)):
                ready(**values)


class ProjectReaderIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.directory = str(pathlib.Path(self.temp.name).resolve())
        self.patch = mock.patch.dict(os.environ, {'TEST_SESSION_PROJECT':self.directory})
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.command = [sys.executable, '-u', str(ROOT/'tests'/'fake_app_server.py')]
        self.adapter = CodexAdapter(self.directory, command=self.command, timeout=10)
    def test_list_excludes_other_project_and_previews(self):
        result = self.adapter.list_sessions()
        self.assertEqual([x['id'] for x in result['sessions']], ['good'])
        self.assertNotIn('private test content', str(result))
    def test_status_and_goal_are_scoped_and_redacted(self):
        self.assertEqual(self.adapter.session_status('good')['latest_turn']['status'], 'completed')
        result = self.adapter.goal_status('good')
        self.assertEqual(result['goal']['status'], 'active')
        self.assertNotIn('private synthetic objective', str(result))
        with self.assertRaises(PermissionError): self.adapter.session_status('wrong-project')
        with self.assertRaises(PermissionError): self.adapter.goal_status('wrong-project')
    def test_outcome_requires_authorization_and_is_bounded(self):
        with self.assertRaises(PermissionError): self.adapter.session_outcome('good')
        with self.assertRaises(PermissionError): self.adapter.session_outcome('good', authorized=1)
        result = self.adapter.session_outcome('good', authorized=True, max_chars=5)
        self.assertEqual(result['outcome']['text'], 'synth')
        self.assertTrue(result['outcome']['truncated'])
        with self.assertRaises(PermissionError): self.adapter.session_outcome('wrong-project', authorized=True)

    def test_limits_remove_extra_account_fields(self):
        result = self.adapter.rate_limits()
        self.assertEqual(result['rate_limits']['primary']['usedPercent'], 95)
        self.assertNotIn('private synthetic', str(result))
    def test_no_prompt_or_session_write_api(self):
        for name in ('send','resume','create','delete'):
            self.assertFalse(hasattr(self.adapter,name))

if __name__ == '__main__': unittest.main()
