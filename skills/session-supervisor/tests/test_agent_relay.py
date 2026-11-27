import json
import os
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import agent_relay as relay


class Clock:
    def __init__(self, value=1000.0): self.value = value
    def __call__(self): return self.value


class Fingerprints:
    """Returns a new fingerprint on each call unless frozen (no progress)."""
    def __init__(self): self.n, self.frozen = 0, False
    def __call__(self, project, task_dir):
        if not self.frozen:
            self.n += 1
        return str(self.n)


class RelayBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.task = pathlib.Path(self.tmp.name)
        self.clock = Clock()
        self.fp = Fingerprints()
        self.calls = []
        self.limits = (False, None)
        relay.save(self.task, {**relay.load(self.task), 'project': self.tmp.name})

    def tearDown(self):
        self.tmp.cleanup()

    def runner(self, result=None, during=None):
        def run(agent, state, task_dir):
            self.calls.append(agent)
            if during:
                during()
            return {'exit': 0, 'limited': False, 'usage': None, **(result or {})}
        return run

    def tick(self, runner=None):
        return relay.tick_task(self.task, now=self.clock, runner=runner or self.runner(),
                               limits=lambda: self.limits, fingerprinter=self.fp)

    def state(self):
        return relay.load(self.task)

    def handoff(self, to):
        relay.main(['handoff', '--task-dir', str(self.task), '--to', to])

    def signal(self, **value):
        return lambda: (self.task / relay.SIGNAL).write_text(json.dumps(value))


class RelayTest(RelayBase):
    def test_idle_task_is_not_dispatched(self):
        self.assertEqual(self.tick(), 'idle')
        self.assertEqual(self.calls, [])

    def test_handoff_runs_target_once_and_continues_on_progress(self):
        self.handoff('claude')
        self.assertEqual(self.tick(), 'ran claude: pending')
        s = self.state()
        self.assertEqual((s['next'], s['hops'], s['history'][-1]['progressed']), ('claude', 1, True))

    def test_complete_signal_stops_relay(self):
        self.handoff('claude')
        self.tick(self.runner(during=self.signal(action='complete')))
        self.assertEqual(self.state()['state'], 'complete')
        self.assertEqual(self.tick(), 'complete')
        self.assertEqual(self.calls, ['claude'])

    def tasks(self, *passes):
        items = [{'id': f't{i}', 'check': 'pytest', 'passes': v} for i, v in enumerate(passes, 1)]
        (self.task / relay.TASKS).write_text(json.dumps(items))

    def test_complete_refused_while_checklist_item_fails(self):
        self.tasks(True, False)
        self.handoff('codex')
        self.assertEqual(self.tick(self.runner(during=self.signal(action='complete'))), 'ran codex: pending')
        s = self.state()
        self.assertEqual((s['state'], s['next']), ('pending', 'codex'))
        self.assertIn('t2', s['reason'])
        self.assertIn('refused', s['history'][-1])
        self.assertNotIn('refused', s)

    def test_complete_accepted_when_checklist_passes(self):
        self.tasks(True, True)
        self.handoff('claude')
        self.tick(self.runner(during=self.signal(action='complete')))
        self.assertEqual(self.state()['state'], 'complete')

    def test_repeated_false_complete_stops_on_no_progress(self):
        self.tasks(False)
        self.handoff('claude')
        self.fp.frozen = True
        for _ in range(3):
            self.tick(self.runner(during=self.signal(action='complete')))
        s = self.state()
        self.assertEqual(s['state'], 'stopped')
        self.assertIn('complete refused', s['reason'])

    def test_unfinished_items_formats(self):
        self.assertEqual(relay.unfinished_items(self.task), [])
        (self.task / relay.TASKS).write_text('{"tasks": [{"name": "a", "passes": true}, {"name": "b"}]}')
        self.assertEqual(relay.unfinished_items(self.task), ['b'])
        (self.task / relay.TASKS).write_text('not json')
        self.assertEqual(relay.unfinished_items(self.task), [])

    def test_prompt_names_checklist(self):
        self.assertIn(relay.TASKS, relay.build_prompt('claude', self.task))

    def test_handoff_signal_beats_limit(self):
        self.handoff('claude')
        self.tick(self.runner({'limited': True}, during=self.signal(action='handoff', to='claude')))
        self.assertEqual((self.state()['next'], self.state()['state']), ('claude', 'pending'))
        self.assertFalse((self.task / relay.SIGNAL).exists())

    def test_stop_signal(self):
        self.handoff('codex')
        self.tick(self.runner(during=self.signal(action='stop', reason='need decision')))
        self.assertEqual((self.state()['state'], self.state()['reason']), ('stopped', 'need decision'))

    def test_invalid_or_stale_signal_ignored(self):
        self.handoff('claude')
        self.signal(action='complete')()  # left over before the run: discarded
        self.tick(self.runner(during=self.signal(action='handoff', to='nobody')))
        self.assertEqual((self.state()['state'], self.state()['next']), ('pending', 'claude'))

    def test_cli_handoff_during_run_is_respected(self):
        self.handoff('claude')
        self.tick(self.runner(during=lambda: self.handoff('codex')))
        self.assertEqual((self.state()['state'], self.state()['next']), ('pending', 'codex'))

    def test_limit_switches_to_other_agent(self):
        self.handoff('claude')
        self.fp.frozen = True
        self.tick(self.runner({'limited': True}))
        s = self.state()
        self.assertEqual((s['state'], s['next'], s['no_progress']), ('pending', 'codex', 0))

    def test_codex_limited_waits_until_reset_without_running(self):
        self.handoff('codex')
        self.limits = (True, 5000.0)
        self.assertEqual(self.tick(), 'waiting')
        self.assertEqual(self.state()['not_before'], 5000.0)
        self.clock.value = 4999
        self.assertEqual(self.tick(), 'waiting')
        self.limits = (False, None)
        self.clock.value = 5000
        self.assertEqual(self.tick(), 'ran codex: pending')
        self.assertEqual(self.calls, ['codex'])

    def test_no_progress_stops_after_budget(self):
        self.handoff('claude')
        self.fp.frozen = True
        self.tick()
        self.assertEqual(self.state()['state'], 'pending')
        self.tick()
        self.assertEqual(self.state()['state'], 'stopped')
        self.assertEqual(len(self.calls), 2)

    def test_hop_budget(self):
        relay.save(self.task, {**self.state(), 'max_hops': 1})
        self.handoff('claude')
        self.tick()
        self.assertEqual(self.tick(), 'stopped')
        self.assertEqual(self.calls, ['claude'])

    def test_live_lock_blocks_second_run(self):
        self.handoff('claude')
        (self.task / 'relay.lock').write_text(json.dumps({'pid': os.getpid()}))
        self.assertEqual(self.tick(), 'locked')
        self.assertEqual(self.calls, [])

    def test_stale_lock_is_recovered(self):
        self.handoff('claude')
        (self.task / 'relay.lock').write_text(json.dumps({'pid': 2 ** 22 + 7}))
        self.assertTrue(self.tick().startswith('ran claude'))
        self.assertFalse((self.task / 'relay.lock').exists())

    def test_watch_codex_limit_hands_idle_task_to_claude(self):
        relay.save(self.task, {**self.state(), 'watch_codex_limit': True})
        self.limits = (True, 9999.0)
        self.assertEqual(self.tick(), 'ran claude: pending')
        self.assertEqual(self.calls, ['claude'])

    def test_watch_off_ignores_codex_limit(self):
        self.limits = (True, 9999.0)
        self.assertEqual(self.tick(), 'idle')

    def test_codex_limit_reader(self):
        full = {'rate_limits': {'primary': {'usedPercent': 100, 'resetsAt': 50},
                                'secondary': {'usedPercent': 20, 'resetsAt': 90}, 'rateLimitReachedType': None}}
        self.assertEqual(relay.codex_limit(lambda: full), (True, 50))
        ok = {'rate_limits': {'primary': {'usedPercent': 3, 'resetsAt': 50}, 'rateLimitReachedType': None}}
        self.assertEqual(relay.codex_limit(lambda: ok), (False, None))
        self.assertEqual(relay.codex_limit(lambda: 1 / 0), (False, None))

    def test_parse_claude_output(self):
        ok = '﻿{"is_error":false,"result":"done","total_cost_usd":0.1,"usage":{"input_tokens":2,"output_tokens":9}}'
        self.assertEqual(relay.parse_output('claude', ok)['usage']['output_tokens'], 9)
        limit = '{"is_error":true,"result":"Claude AI usage limit reached|1794800000"}'
        self.assertTrue(relay.parse_output('claude', limit)['limited'])
        self.assertFalse(relay.parse_output('claude', '{"is_error":true,"result":"tool failed"}')['limited'])

    def test_parse_codex_output(self):
        text = '\n'.join([
            '{"type":"thread.started","thread_id":"x"}',
            'ERROR noise line',
            '{"type":"turn.completed","usage":{"input_tokens":23187,"output_tokens":7}}',
            '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit"}}'])
        out = relay.parse_output('codex', text)
        self.assertEqual((out['usage']['input_tokens'], out['limited']), (23187, True))

    def test_prompt_names_recipient_file_and_relay_commands(self):
        prompt = relay.build_prompt('codex', self.task)
        self.assertIn('CODEX_CONTINUATION_PROMPT.md', prompt)
        self.assertIn('relay-signal.json', prompt)
        self.assertIn('"to": "claude"', prompt)


LIMIT_STOP = {'turn_id': 't1', 'quiet': 600, 'limited': True}


class CodexThreadTest(RelayBase):
    def setUp(self):
        super().setUp()
        relay.save(self.task, {**self.state(), 'codex_thread': 'th-1'})
        self.stop = dict(LIMIT_STOP)

    def tick(self, runner=None):
        return relay.tick_task(self.task, now=self.clock, runner=runner or self.runner(),
                               limits=lambda: self.limits, fingerprinter=self.fp,
                               thread_stop=lambda t: self.stop)

    def test_limit_stop_resumes_same_chat_once(self):
        self.assertEqual(self.tick(self.runner(during=self.signal(action='complete'))), 'ran codex: complete')
        self.assertEqual(self.state()['continued_turn'], 't1')
        self.assertEqual(self.tick(), 'idle')  # same failed turn is never continued twice
        self.assertEqual(self.calls, ['codex'])

    def test_new_limit_stop_after_complete_is_continued_again(self):
        self.tick(self.runner(during=self.signal(action='complete')))
        self.stop = {**LIMIT_STOP, 'turn_id': 't2'}
        self.assertTrue(self.tick().startswith('ran codex'))
        self.assertEqual(self.calls, ['codex', 'codex'])

    def test_waits_for_reset_before_resuming(self):
        self.limits = (True, 5000.0)
        self.assertEqual(self.tick(), 'waiting')
        self.assertEqual(self.calls, [])

    def test_busy_chat_is_not_touched(self):
        self.stop = {**LIMIT_STOP, 'quiet': 30}
        self.assertEqual(self.tick(), 'busy')
        self.stop = None  # a turn started meanwhile
        self.assertEqual(self.tick(), 'busy')
        self.assertEqual(self.calls, [])

    def test_normal_stop_is_ignored(self):
        self.stop = {**LIMIT_STOP, 'limited': False}
        self.assertEqual(self.tick(), 'idle')

    def test_claude_takeover(self):
        relay.save(self.task, {**self.state(), 'watch_codex_limit': True})
        self.limits = (True, 5000.0)
        self.assertEqual(self.tick(), 'ran claude: pending')

    def test_resume_command_and_prompt(self):
        cmd = relay.command('codex', {**self.state(), 'project': self.tmp.name}, self.task)
        self.assertEqual(cmd[1:4], ['exec', 'resume', 'th-1'])
        self.assertIn('sandbox_mode="workspace-write"', cmd)
        self.assertIn('stopped at a usage limit', relay.build_prompt('codex', self.task, resumed=True))

    def test_reads_real_rollout_shape(self):
        path = self.task / 'rollout.jsonl'
        events = [{'type': 'session_meta', 'payload': {'cwd': 'C:/p'}},
                  {'type': 'event_msg', 'payload': {'type': 'task_started'}},
                  {'type': 'event_msg', 'payload': {'type': 'task_complete', 'turn_id': 'tx', 'error': {
                      'message': 'You have hit your usage limit.', 'codex_error_info': 'usage_limit_exceeded'}}}]
        path.write_text('\n'.join(json.dumps(e) for e in events))
        stop = relay.codex_thread_stop('x', now=lambda: os.path.getmtime(path) + 300, rollout=lambda t: path)
        self.assertEqual((stop['turn_id'], stop['limited'], round(stop['quiet'])), ('tx', True, 300))
        path.write_text('\n'.join(json.dumps(e) for e in events[:2]))
        self.assertIsNone(relay.codex_thread_stop('x', rollout=lambda t: path))


if __name__ == '__main__':
    unittest.main()
