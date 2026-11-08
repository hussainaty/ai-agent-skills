import importlib.util
import json
import os
import signal
import sys
import time
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('claude_adapter', ROOT / 'scripts' / 'claude_adapter.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
ID = '4d3239d4-e9a4-4278-8b6e-c68fb87c509e'
OTHER = '7db12b04-3d57-4cad-94b0-cbbfdba6863c'


class FakeSDK:
    def __init__(self, rows=()): self.rows = rows
    def list_sessions(self, **kwargs): return list(self.rows)


class Runner:
    def __init__(self, rows=None, response=None, resume_error=None):
        self.rows = rows if rows is not None else []
        self.response = response
        self.resume_error = resume_error
        self.calls = []
    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if '--version' in argv:
            return subprocess.CompletedProcess(argv, 0, '2.1.303 (Claude Code)\n', '')
        if 'auth' in argv:
            return subprocess.CompletedProcess(argv, 1, json.dumps({'loggedIn': False, 'secret':'not-to-return'}), '')
        if 'agents' in argv:
            return subprocess.CompletedProcess(argv, 0, json.dumps(self.rows), '')
        if self.resume_error:
            raise self.resume_error
        return subprocess.CompletedProcess(argv, 0, json.dumps(self.response), '')


class OrganizingSDK:
    def __init__(self, cwd, sid=ID, fail_update=False, no_effect=False):
        self.row={'cwd':cwd,'session_id':sid,'custom_title':'old','tag':'old'}
        self.calls=[];self.fail_update=fail_update;self.no_effect=no_effect
    def get_session_info(self,sid,**kwargs):
        self.calls.append(('get',sid,kwargs));return dict(self.row)
    def rename_session(self,sid,value,**kwargs):
        self.calls.append(('rename',sid,kwargs))
        if self.fail_update:raise OSError('private details')
        if not self.no_effect:self.row['custom_title']=value
    def tag_session(self,sid,value,**kwargs):
        self.calls.append(('tag',sid,kwargs))
        if self.fail_update:raise OSError('private details')
        if not self.no_effect:self.row['tag']=value


class ClaudeAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = str(Path(self.temp.name).resolve())
        self.patch = mock.patch.object(m, '_resolve_cli', return_value='fake-claude')
        self.patch.start(); self.addCleanup(self.patch.stop)
    def row(self, **kwargs):
        return {'cwd': self.root, 'sessionId': ID, 'kind': 'background', 'id': 'job123', 'state': 'stopped', **kwargs}
    def call(self, runner, **kwargs):
        return m.resume_session(self.root, ID, 'continue safely', runner=runner,
                                sdk=FakeSDK(), authorized=True, model_use_authorized=True, **kwargs)
    def test_probe_returns_only_safe_auth_metadata(self):
        runner = Runner()
        with mock.patch.object(m, '_sdk', return_value=None): result = m.probe(runner=runner)
        self.assertEqual(result['version'], '2.1.303')
        self.assertIs(result['authenticated'], False)
        self.assertNotIn('not-to-return', str(result))
    def test_project_scoped_list_redacts_content_and_filters_other_projects(self):
        runner = Runner([self.row(name='private summary'), self.row(cwd=self.root+'-other', sessionId=OTHER)])
        sdk = FakeSDK([{'cwd': self.root, 'session_id': OTHER, 'summary':'private transcript'}])
        result = m.list_sessions(self.root, runner=runner, sdk=sdk)
        self.assertEqual({x['id'] for x in result['sessions']}, {ID, OTHER})
        self.assertNotIn('private', str(result))
        self.assertEqual(result['history'], 'available')
    def test_wrong_or_missing_cwd_does_not_prove_membership(self):
        runner = Runner([self.row(cwd=None)])
        sdk = FakeSDK([{'cwd':None, 'session_id': ID}])
        self.assertEqual(m.list_sessions(self.root, runner=runner, sdk=sdk)['sessions'], [])
    def test_missing_sdk_is_reported_without_claiming_empty_history(self):
        with mock.patch.object(m, '_sdk', return_value=None):
            result = m.list_sessions(self.root, runner=Runner(), sdk=None)
        self.assertEqual(result['history'], 'unavailable')
    def test_no_authorization_does_not_run_cli(self):
        runner = Runner([self.row()])
        with self.assertRaises(PermissionError):
            m.resume_session(self.root, ID, 'x', runner=runner, sdk=FakeSDK(), authorized=True)
        self.assertFalse(runner.calls)
    def test_cross_project_resume_is_rejected(self):
        runner = Runner([self.row(cwd=self.root+'-other')])
        with self.assertRaises(m.ClaudeSessionError): self.call(runner)
        self.assertEqual(len(runner.calls), 1)
    def test_active_or_waiting_session_is_not_steered(self):
        for extra in ({'status':'idle','pid':123}, {'state':'working'}, {'status':'waiting','waitingFor':'permission prompt'}):
            with self.subTest(extra=extra):
                runner=Runner([self.row(**extra)])
                with self.assertRaises(m.ClaudeSessionError): self.call(runner)
                self.assertEqual(len(runner.calls), 1)
    def test_duplicate_live_and_stopped_entries_never_resume(self):
        runner=Runner([self.row(status='busy',pid=123), self.row(state='stopped')])
        with self.assertRaises(m.ClaudeSessionError): self.call(runner)
        self.assertEqual(len(runner.calls), 1)
    def test_unknown_or_incomplete_session_state_cannot_resume(self):
        for extra in ({'state':None}, {'state':'future-state'}, {'status':'future-status'},
                      {'waitingFor':'future-wait'}, {'pid':'bad-pid'}, {'kind':'interactive'}):
            runner=Runner([self.row(**extra)])
            with self.subTest(extra=extra), self.assertRaises(m.ClaudeSessionError): self.call(runner)
            self.assertEqual(len(runner.calls),1)
    def test_sdk_only_history_does_not_prove_session_stopped(self):
        runner=Runner([]);sdk=FakeSDK([{'cwd':self.root,'session_id':ID}])
        with self.assertRaises(m.ClaudeSessionError):
            m.resume_session(self.root,ID,'continue',runner=runner,sdk=sdk,authorized=True,model_use_authorized=True)
        self.assertEqual(len(runner.calls),1)
    def test_unidentified_project_session_blocks_resume(self):
        unidentified={'cwd':self.root, 'kind':'interactive', 'status':'busy'}
        runner=Runner([self.row(), unidentified])
        with self.assertRaises(m.ClaudeSessionError): self.call(runner)
        self.assertEqual(len(runner.calls), 1)
    def test_success_requires_verified_session_and_prompt_on_stdin(self):
        runner=Runner([self.row()], {'session_id':ID,'subtype':'success','is_error':False,'result':'sensitive output'})
        result=self.call(runner)
        self.assertEqual(result['state'],'completed')
        argv,kw=runner.calls[-1]
        self.assertEqual(argv[1:], ['--resume',ID,'--print','--output-format','json'])
        self.assertEqual(kw['input'],'continue safely')
        self.assertNotIn('continue safely',str(argv))
        self.assertIs(kw['shell'],False)
        self.assertNotIn('sensitive output',str(result))
    def test_timeout_is_unknown_and_never_retried(self):
        runner=Runner([self.row()],resume_error=subprocess.TimeoutExpired('x',1))
        self.assertEqual(self.call(runner)['state'],'unknown')
        self.assertEqual(len(runner.calls),2)
    def test_mismatched_result_is_unknown(self):
        runner=Runner([self.row()],{'session_id':OTHER,'subtype':'success','is_error':False})
        self.assertEqual(self.call(runner)['state'],'unknown')
    def test_error_result_is_failed_without_retries(self):
        runner=Runner([self.row()],{'session_id':ID,'subtype':'error_during_execution','is_error':True,'result':'secret'})
        result=self.call(runner)
        self.assertEqual(result['state'],'failed');self.assertNotIn('secret',str(result))
        self.assertEqual(len(runner.calls),2)
    def test_session_id_must_be_canonical_full_uuid(self):
        for value in ('x', ID.replace('-',''), '--continue', '', None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                m.resume_session(self.root, value, 'x', authorized=True, model_use_authorized=True, runner=Runner())
    def test_authorized_bounded_outcome_masks_common_secret(self):
        runner=Runner([self.row()], {'session_id':ID,'subtype':'success','is_error':False,
                                    'result':'api_key=super-secret-value and useful output'})
        result=self.call(runner, include_outcome=True, max_outcome_chars=35)
        self.assertNotIn('super-secret-value', result['outcome'])
        self.assertIn('[REDACTED]',result['outcome'])
        self.assertLessEqual(len(result['outcome']),35)
        self.assertIn('best effort',result['outcome_note'])
    def test_new_session_requires_explicit_authorization(self):
        runner=Runner()
        with self.assertRaises(PermissionError):
            m.start_session(self.root,'hello',runner=runner,model_use_authorized=True)
        self.assertFalse(runner.calls)
    def test_new_session_uses_generated_id_and_input_not_command_line(self):
        runner=Runner(response={'session_id':ID,'subtype':'success','is_error':False})
        with mock.patch.object(m.uuid,'uuid4',return_value=ID):
            result=m.start_session(self.root,'private prompt',runner=runner,authorized=True,model_use_authorized=True)
        self.assertEqual(result['state'],'completed')
        argv,kw=runner.calls[0]
        self.assertEqual(argv[1:],['--session-id',ID,'--print','--output-format','json'])
        self.assertNotIn('private prompt',str(argv))
        self.assertEqual(kw['input'],'private prompt')
    def test_new_session_timeout_preserves_id_and_never_retries(self):
        runner=Runner(resume_error=subprocess.TimeoutExpired('x',1))
        with mock.patch.object(m.uuid,'uuid4',return_value=ID):
            result=m.start_session(self.root,'hello',runner=runner,authorized=True,model_use_authorized=True)
        self.assertEqual(result['state'],'unknown')
        self.assertEqual(result['session_id'],ID)
        self.assertEqual(len(runner.calls),1)
    def test_bad_outcome_limit_is_rejected_before_launch(self):
        runner=Runner()
        with self.assertRaises(ValueError):
            m.start_session(self.root,'hello',runner=runner,authorized=True,model_use_authorized=True,max_outcome_chars=100000)
        self.assertFalse(runner.calls)
    def test_session_status_is_project_scoped(self):
        runner=Runner([self.row(state='working', status='busy', pid=42)])
        status=m.session_status(self.root, ID, runner=runner, sdk=FakeSDK())
        self.assertEqual(status['session']['state'],'working')
        self.assertEqual(status['session']['background_id'],'job123')
    def test_stop_requires_explicit_authorization(self):
        runner=Runner([self.row(state='working')])
        with self.assertRaises(PermissionError):m.stop_session(self.root,ID,runner=runner,sdk=FakeSDK())
        self.assertFalse(runner.calls)
    def test_stop_background_session_is_ack_only(self):
        runner=Runner([self.row(state='working',status='busy',pid=42)])
        result=m.stop_session(self.root,ID,authorized=True,runner=runner,sdk=FakeSDK())
        self.assertEqual(result['state'],'stop_requested')
        self.assertEqual(runner.calls[-1][0][1:],['stop','job123'])
        self.assertEqual(len(runner.calls),2)
    def test_stop_refuses_cross_project_and_unverified_short_id(self):
        for row in (self.row(cwd=self.root+'-other'), self.row(id='--all')):
            runner=Runner([row])
            with self.subTest(row=row), self.assertRaises(m.ClaudeSessionError):
                m.stop_session(self.root,ID,authorized=True,runner=runner,sdk=FakeSDK())
            self.assertEqual(len(runner.calls),1)
    def test_sdk_rename_and_clear_tag_confirm_readback(self):
        sdk=OrganizingSDK(self.root)
        self.assertEqual(m.rename_session(self.root,ID,'New title',authorized=True,sdk=sdk)['state'],'updated')
        self.assertEqual(m.tag_session(self.root,ID,None,authorized=True,sdk=sdk)['state'],'updated')
        self.assertEqual(sdk.row['custom_title'],'New title');self.assertIsNone(sdk.row['tag'])
    def test_sdk_changes_require_authorization_before_access(self):
        sdk=OrganizingSDK(self.root)
        with self.assertRaises(PermissionError):m.rename_session(self.root,ID,'x',sdk=sdk)
        self.assertEqual(sdk.calls,[])
    def test_sdk_cross_project_never_mutates(self):
        sdk=OrganizingSDK(self.root+'-other')
        with self.assertRaises(m.ClaudeSessionError):m.rename_session(self.root,ID,'x',authorized=True,sdk=sdk)
        self.assertEqual([x[0] for x in sdk.calls],['get'])
    def test_sdk_update_error_is_unknown_without_private_error_or_retry(self):
        sdk=OrganizingSDK(self.root,fail_update=True)
        result=m.tag_session(self.root,ID,'x',authorized=True,sdk=sdk)
        self.assertEqual(result['state'],'unknown');self.assertNotIn('private details',str(result))
        self.assertEqual([x[0] for x in sdk.calls],['get','tag'])
    def test_sdk_update_without_matching_readback_is_unknown(self):
        sdk=OrganizingSDK(self.root,no_effect=True)
        result=m.rename_session(self.root,ID,'x',authorized=True,sdk=sdk)
        self.assertEqual(result['state'],'unknown')
    def test_sdk_missing_is_explicit_failure(self):
        with self.assertRaises(m.ClaudeSessionError):
            m.rename_session(self.root,ID,'x',authorized=True,sdk=object())
    def test_real_process_timeout_does_not_wait_for_inherited_handles(self):
        marker=Path(self.root)/'descendant-pid'
        code=("import subprocess,sys,time; "
              "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],close_fds=False); "
              "open(sys.argv[1],'w').write(str(p.pid)); time.sleep(30)")
        started=time.monotonic()
        try:
            with mock.patch.object(m,'_resolve_cli',return_value=sys.executable):
                with self.assertRaises(TimeoutError):
                    m._run(['-c',code,str(marker)],timeout=2,input_text='x'*16000)
            self.assertLess(time.monotonic()-started,5.0)
            self.assertTrue(marker.exists(),'synthetic descendant was never started')
        finally:
            if marker.exists():
                try:os.kill(int(marker.read_text(encoding='utf-8')),signal.SIGTERM)
                except (OSError,ValueError):pass
    def test_real_process_output_is_bounded_before_memory_capture(self):
        code="import sys; sys.stdout.write('x' * (4*1024*1024+1)); sys.stdout.flush()"
        with mock.patch.object(m,'_resolve_cli',return_value=sys.executable):
            with self.assertRaises(TimeoutError):m._run(['-c',code],timeout=10)
    def test_summary_lookup_returns_bounded_authorized_metadata_only(self):
        sdk=OrganizingSDK(self.root)
        sdk.row.update({'summary':'api_key=super-secret-value useful summary',
                        'custom_title':'A'*400, 'tag':'B'*200, 'last_modified':123456,
                        'first_prompt':'never return this prompt'})
        result=m.read_session_summary(self.root,ID,authorized=True,sdk=sdk,max_chars=30)
        self.assertLessEqual(len(result['summary']),30)
        self.assertIn('[REDACTED]',result['summary'])
        self.assertNotIn('super-secret-value',str(result))
        self.assertNotIn('never return this prompt',str(result))
        self.assertLessEqual(len(result['title']),30);self.assertLessEqual(len(result['tag']),30)
        self.assertEqual(result['last_modified_ms'],123456)
        self.assertIn('private data',result['note'])
    def test_summary_requires_explicit_authorization_before_sdk_access(self):
        sdk=OrganizingSDK(self.root)
        with self.assertRaises(PermissionError):m.read_session_summary(self.root,ID,sdk=sdk)
        self.assertEqual(sdk.calls,[])
    def test_summary_rejects_cross_project(self):
        sdk=OrganizingSDK(self.root+'-other')
        with self.assertRaises(m.ClaudeSessionError):m.read_session_summary(self.root,ID,authorized=True,sdk=sdk)
    def test_summary_handles_missing_fields_and_invalid_timestamp(self):
        sdk=OrganizingSDK(self.root);sdk.row['last_modified']=float('nan')
        result=m.read_session_summary(self.root,ID,authorized=True,sdk=sdk)
        self.assertIsNone(result['summary']);self.assertIsNone(result['last_modified_ms'])
    def test_summary_rejects_invalid_bound(self):
        sdk=OrganizingSDK(self.root)
        with self.assertRaises(ValueError):m.read_session_summary(self.root,ID,authorized=True,sdk=sdk,max_chars=8001)
        self.assertEqual(sdk.calls,[])
    def test_supervisor_timeout_leaves_real_worker_alive(self):
        marker=Path(self.root)/'worker-survived'
        code="import sys,time; from pathlib import Path; prompt=sys.stdin.read(); time.sleep(1); Path(sys.argv[1]).write_text(prompt); time.sleep(30)"
        result=None
        try:
            started=time.monotonic()
            with mock.patch.object(m,'_resolve_cli',return_value=sys.executable):
                result=m._launch_session_preserving(self.root,ID,['-c',code,str(marker)],'private prompt',0.25,True)
            self.assertEqual(result['state'],'running_unobserved')
            self.assertEqual(result['session_id'],ID)
            self.assertIsNone(result['outcome'])
            self.assertLess(time.monotonic()-started,2)
            deadline=time.monotonic()+4
            while not marker.exists() and time.monotonic()<deadline:time.sleep(.05)
            self.assertTrue(marker.exists(),'worker did not survive supervisor timeout')
            self.assertEqual(marker.read_text(encoding='utf-8'),'private prompt')
        finally:
            if result and result.get('pid'):
                try:os.kill(result['pid'],signal.SIGTERM)
                except OSError:pass
                deadline=time.monotonic()+4
                while result['pid'] in m._RUNNING_PROCESSES and time.monotonic()<deadline:time.sleep(.05)
                self.assertNotIn(result['pid'],m._RUNNING_PROCESSES,'terminated worker was not reaped')
    def test_real_worker_early_exit_is_not_claimed_as_success(self):
        with mock.patch.object(m,'_resolve_cli',return_value=sys.executable):
            result=m._launch_session_preserving(self.root,ID,['-c','print("hidden output")'],'prompt',5,True)
        self.assertEqual(result['state'],'finished_unverified')
        self.assertEqual(result['exit_code'],0)
        self.assertIsNone(result['outcome'])
        self.assertNotIn('hidden output',str(result))
    def test_real_launch_resumes_through_detached_safe_path(self):
        runner=Runner([self.row()])
        with mock.patch.object(m,'list_sessions',return_value={'sessions':[{'id':ID,'source':'claude_agents','kind':'background','state':'stopped','status':None,'waiting_for':None,'process_alive_reported':False}],'unidentified_project_entries':0,'duplicate_session_ids':[]}), \
             mock.patch.object(m,'_launch_session_preserving',return_value={'state':'running_unobserved','session_id':ID}) as launch:
            result=m.resume_session(self.root,ID,'prompt',authorized=True,model_use_authorized=True,sdk=FakeSDK(),timeout=.2)
        self.assertEqual(result['state'],'running_unobserved')
        self.assertEqual(launch.call_count,1)
    def test_relative_project_rejected(self):
        with self.assertRaises(ValueError):m.list_sessions('.',runner=Runner())

if __name__ == '__main__':unittest.main()
