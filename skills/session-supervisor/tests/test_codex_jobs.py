import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import codex_jobs


class FakeProcess:
    pid = 4242


class CodexJobsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = pathlib.Path(self.tmp.name) / 'proj'
        self.project.mkdir()
        patches = [mock.patch.object(codex_jobs, 'JOBS', pathlib.Path(self.tmp.name) / 'jobs'),
                   mock.patch.object(codex_jobs, 'resolve_codex', lambda: 'codex.exe')]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.launched = []

    def tearDown(self):
        self.tmp.cleanup()

    def popen(self, argv, **kwargs):
        self.launched.append((argv, kwargs, kwargs['stdin'].read().decode()))
        return FakeProcess()

    def start(self, **kw):
        return codex_jobs.start(str(self.project), 'do the work', popen=self.popen, **kw)

    def finish(self, job_id, events, last='All done'):
        folder = codex_jobs.JOBS / job_id
        (folder / 'events.jsonl').write_text('\n'.join(json.dumps(e) for e in events))
        if last is not None:
            (folder / 'last.txt').write_text(last)

    def test_start_runs_new_exec_detached_with_prompt_on_stdin(self):
        job = self.start()
        argv, kwargs, stdin = self.launched[0]
        self.assertEqual(argv[:4], ['codex.exe', 'exec', '-C', str(self.project.resolve())])
        self.assertIn('workspace-write', argv)
        self.assertEqual((stdin, kwargs['cwd']), ('do the work', str(self.project.resolve())))
        self.assertEqual(job['status'], 'running')

    def test_resume_thread_uses_exec_resume(self):
        self.start(thread_id='th-9', sandbox='read-only')
        argv = self.launched[0][0]
        self.assertEqual(argv[1:4], ['exec', 'resume', 'th-9'])
        self.assertIn('sandbox_mode="read-only"', argv)

    def test_rejects_bad_sandbox_and_empty_prompt(self):
        with self.assertRaises(ValueError):
            self.start(sandbox='danger-full-access')
        with self.assertRaises(ValueError):
            codex_jobs.start(str(self.project), '  ', popen=self.popen)

    def test_running_then_completed(self):
        job_id = self.start()['job_id']
        self.assertEqual(codex_jobs.result(job_id, alive=lambda pid: True)['status'], 'running')
        self.finish(job_id, [{'type': 'thread.started', 'thread_id': 'th-1'},
                             {'type': 'turn.completed', 'usage': {'input_tokens': 10, 'output_tokens': 2}}])
        out = codex_jobs.result(job_id, alive=lambda pid: False)
        self.assertEqual((out['status'], out['thread_id'], out['final_message']), ('completed', 'th-1', 'All done'))
        self.assertEqual(out['usage']['input_tokens'], 10)

    def test_limit_failure_is_reported(self):
        job_id = self.start()['job_id']
        self.finish(job_id, [{'type': 'turn.failed', 'error': {'message': "You've hit your usage limit"}}], last=None)
        out = codex_jobs.result(job_id, alive=lambda pid: False)
        self.assertEqual((out['status'], out['limited']), ('failed', True))

    def test_wait_timeout_returns_running(self):
        job_id = self.start()['job_id']
        out = codex_jobs.wait(job_id, timeout=0, alive=lambda pid: True)
        self.assertEqual(out['status'], 'running')
        self.assertNotIn('final_message', out)

    def test_job_ids_are_validated(self):
        for bad in ('', '../x', 'a/b'):
            with self.assertRaises(ValueError):
                codex_jobs.result(bad)
        with self.assertRaises(KeyError):
            codex_jobs.result('nope')


if __name__ == '__main__':
    unittest.main()
