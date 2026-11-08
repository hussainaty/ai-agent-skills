import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from wake_scheduler import WakeScheduler


class Clock:
    def __init__(self, value=100): self.value = value
    def __call__(self): return self.value


class FakeHost:
    def __init__(self):
        self.caps = {'backend':'codex', 'atomic_conditional_dispatch': True, 'deduplicated_dispatch': True, 'cancel_fencing': True}
        self.view = {'authorized': True, 'account_match': True, 'session_status': 'idle',
                     'last_turn_id': 'turn-1', 'last_turn_result': 'temporary_rate_limit',
                     'approval_pending': False, 'queued_input': False, 'goal_state': 'active',
                     'reset_at': 100, 'limit_active': False}
        self.calls = []
        self.response = {'status': 'accepted', 'turn_id': 'turn-2'}
    def capabilities(self): return self.caps
    def inspect(self, job):
        self.calls.append('inspect')
        return {'session_id':job['session_id'], 'project':job['project'], **self.view}
    def dispatch_if_idle(self, job): self.calls.append('dispatch'); return self.response


class WakeSchedulerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.db = self.root / 'wake.sqlite'
        self.scheduler = WakeScheduler(self.db)
        self.clock = Clock()
        self.host = FakeHost()

    def schedule(self, *, reset=100, deadline=200, evidence=None, authorized=True, job='job-1', turn='turn-1'):
        evidence = evidence if evidence is not None else {'source': 'host', 'kind': 'temporary_rate_limit', 'terminal': True, 'turn_id': turn}
        return self.scheduler.schedule(job, project=str(self.root), session_id='session-1', failed_turn_id=turn,
                                       reset_at=reset, deadline=deadline, evidence=evidence, authorized=authorized, now=90)

    def test_only_confirmed_temporary_limits_and_authorized_sessions_are_scheduled(self):
        with self.assertRaises(PermissionError): self.schedule(authorized=False)
        for e in ({}, {'source':'model','kind':'temporary_rate_limit','terminal':True,'turn_id':'turn-1'},
                  {'source':'host','kind':'billing','terminal':True,'turn_id':'turn-1'},
                  {'source':'host','kind':'temporary_rate_limit','terminal':False,'turn_id':'turn-1'},
                  {'source':'host','kind':'temporary_rate_limit','terminal':True,'turn_id':'other'}):
            with self.subTest(e=e), self.assertRaises(ValueError): self.schedule(evidence=e)
        self.assertEqual(self.scheduler.list_jobs(), [])

    def test_waits_until_reset_survives_restart_and_sends_once(self):
        self.schedule(reset=120)
        self.assertEqual(self.scheduler.next_wake(now=100), 120)
        self.assertIsNone(self.scheduler.step(self.host, clock=self.clock))
        self.assertEqual(self.host.calls, [])
        resumed = WakeScheduler(self.db)
        self.clock.value = 120
        result = resumed.step(self.host, clock=self.clock)
        self.assertEqual(result['state'], 'accepted')
        self.assertEqual(result['accepted_turn_id'], 'turn-2')
        self.assertIn('completion unverified', result['reason'])
        self.assertIsNone(resumed.step(self.host, clock=self.clock))
        self.assertEqual(self.host.calls, ['inspect', 'dispatch'])

    def test_unsupported_host_blocks_without_inspect_or_spin(self):
        self.schedule(); self.host.caps = {}
        result = self.scheduler.step(self.host, clock=self.clock)
        self.assertEqual(result['state'], 'blocked')
        self.assertEqual(self.host.calls, [])
        self.assertIsNone(self.scheduler.next_wake(now=100))
        self.assertIsNone(self.scheduler.step(self.host, clock=self.clock))
        self.host.caps = {'backend':'codex', 'atomic_conditional_dispatch': True, 'deduplicated_dispatch': True, 'cancel_fencing': True}
        self.scheduler.recheck('job-1', now=101); self.clock.value = 101
        self.assertEqual(self.scheduler.step(self.host, clock=self.clock)['state'], 'accepted')

    def test_working_approval_input_goal_and_identity_fail_closed(self):
        changes = [('session_status','running'), ('approval_pending',True), ('approval_pending',None),
                   ('queued_input',True), ('queued_input',None), ('goal_state','paused'),
                   ('goal_state','budgetLimited'), ('goal_state','blocked'), ('goal_state','complete'),
                   ('goal_state',None), ('authorized',False), ('authorized',None), ('account_match',False),
                   ('last_turn_id','other'), ('last_turn_result','completed'), ('session_id','other'), ('project','other')]
        for index,(key,value) in enumerate(changes):
            with self.subTest(key=key,value=value):
                job, turn = f'job-{index}', f'turn-{index}'
                self.schedule(job=job, turn=turn)
                host=FakeHost();host.view['last_turn_id']=turn;host.view[key]=value
                result=self.scheduler.step(host, clock=self.clock)
                self.assertEqual(result['state'],'blocked')
                self.assertNotIn('dispatch',host.calls)

    def test_extended_limit_moves_due_time_without_dispatch(self):
        self.schedule(); self.host.view.update(limit_active=True,reset_at=130)
        result=self.scheduler.step(self.host,clock=self.clock)
        self.assertEqual((result['state'],result['reset_at']),('pending',130))
        self.assertEqual(self.scheduler.next_wake(now=100),130)
        self.assertNotIn('dispatch',self.host.calls)

    def test_unknown_or_lost_acceptance_never_replays(self):
        self.schedule();self.host.response={'status':'accepted'}
        self.assertEqual(self.scheduler.step(self.host,clock=self.clock)['state'],'unknown')
        self.assertIsNone(self.scheduler.step(self.host,clock=self.clock))
        self.assertEqual(self.host.calls.count('dispatch'),1)

    def test_expired_claim_is_unknown_after_process_restart(self):
        self.schedule(); claim=self.scheduler._claim(100,5)
        self.assertIsNotNone(claim)
        resumed=WakeScheduler(self.db);self.clock.value=106
        self.assertIsNone(resumed.step(self.host,clock=self.clock))
        self.assertEqual(resumed.status('job-1')['state'],'unknown')
        self.assertEqual(self.host.calls,[])

    def test_abandoned_lease_in_another_process_is_not_replayed(self):
        self.schedule()
        result = subprocess.run([sys.executable, str(pathlib.Path(__file__).resolve()),
                                 '--claim-and-exit', str(self.db)], timeout=10, check=False)
        self.assertEqual(result.returncode, 0)
        self.clock.value = 106
        self.assertIsNone(WakeScheduler(self.db).step(self.host, clock=self.clock))
        self.assertEqual(self.scheduler.status('job-1')['state'], 'unknown')
        self.assertEqual(self.host.calls, [])

    def test_cancel_pending_and_cancel_during_inspection_do_not_dispatch(self):
        self.schedule();self.assertEqual(self.scheduler.cancel('job-1')['state'],'cancelled')
        self.assertIsNone(self.scheduler.step(self.host,clock=self.clock))
        self.schedule(job='job-2',turn='turn-2')
        self.host.view['last_turn_id']='turn-2'
        def inspect(job):
            self.scheduler.cancel('job-2')
            self.host.calls.append('inspect')
            return {'session_id':job['session_id'], 'project':job['project'], **self.host.view}
        self.host.inspect=inspect
        result=self.scheduler.step(self.host,clock=self.clock)
        self.assertEqual(result['state'],'cancelled')
        self.assertNotIn('dispatch',self.host.calls)

    def test_cancel_during_host_call_reports_unknown_not_success(self):
        self.schedule()
        def dispatch(job):
            self.scheduler.cancel('job-1')
            self.host.calls.append('dispatch')
            return {'status':'accepted','turn_id':'turn-2'}
        self.host.dispatch_if_idle=dispatch
        self.assertEqual(self.scheduler.step(self.host,clock=self.clock)['state'],'unknown')
        self.assertIsNone(self.scheduler.step(self.host,clock=self.clock))

    def test_deadline_passed_while_inspecting_never_dispatches(self):
        self.schedule(deadline=110)
        def inspect(job):
            self.clock.value=111
            return {'session_id':job['session_id'], 'project':job['project'], **self.host.view}
        self.host.inspect=inspect
        self.assertEqual(self.scheduler.step(self.host,clock=self.clock,lease_seconds=30)['state'],'stopped')
        self.assertNotIn('dispatch',self.host.calls)

    def test_two_workers_do_not_dispatch_same_job(self):
        self.schedule();entered=threading.Event();release=threading.Event();results=[]
        def dispatch(job):
            self.host.calls.append('dispatch');entered.set();release.wait(5)
            return {'status':'accepted','turn_id':'turn-2'}
        self.host.dispatch_if_idle=dispatch
        thread=threading.Thread(target=lambda: results.append(self.scheduler.step(self.host,clock=self.clock)))
        thread.start();self.assertTrue(entered.wait(5))
        self.assertIsNone(WakeScheduler(self.db).step(self.host,clock=self.clock))
        release.set();thread.join(5)
        self.assertFalse(thread.is_alive());self.assertEqual(results[0]['state'],'accepted')
        self.assertEqual(self.host.calls.count('dispatch'),1)

    def test_serve_sleeps_to_reset_without_inference(self):
        self.schedule(reset=150)
        stop=threading.Event()
        class Changed:
            def __init__(self): self.waits=[]
            def wait(self, timeout): self.waits.append(timeout);stop.set()
            def clear(self): pass
        changed=Changed()
        self.scheduler.serve(self.host,stop_event=stop,changed_event=changed,clock=self.clock,max_idle_seconds=60)
        self.assertEqual(changed.waits,[50]);self.assertEqual(self.host.calls,[])

    def test_same_interrupted_turn_cannot_be_scheduled_twice(self):
        self.schedule()
        with self.assertRaises(ValueError): self.schedule(job='other')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--claim-and-exit':
        scheduler = WakeScheduler(sys.argv[2])
        if scheduler._claim(100, 5) is None:
            raise SystemExit(1)
        os._exit(0)
    unittest.main()
