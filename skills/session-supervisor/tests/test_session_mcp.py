import asyncio
import pathlib
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import session_mcp as m


class FakeCodex:
    def __init__(self, project): self.project = project
    def list_sessions(self, limit): return {'project': self.project, 'limit': limit}
    def session_status(self, session_id): return {'project': self.project, 'id': session_id}
    def session_outcome(self, session_id, *, authorized, max_chars):
        return {'id':session_id, 'authorized':authorized, 'max_chars':max_chars}
    def goal_status(self, session_id): return {'id':session_id, 'goal':None}


class SessionMCPTests(unittest.IsolatedAsyncioTestCase):
    async def test_codex_list_is_project_scoped(self):
        with patch.object(m, 'CodexAdapter', FakeCodex):
            result = await m.session_list('codex', 'project-a', 3)
        self.assertEqual(result, {'project':'project-a', 'limit':3})

    async def test_claude_listing_calls_its_adapter(self):
        with patch.object(m.claude_adapter, 'list_sessions', return_value={'sessions':[]}) as fn:
            self.assertEqual(await m.session_list('claude', 'project-a', 4), {'sessions':[]})
        fn.assert_called_once_with('project-a', limit=4)

    async def test_unknown_provider_fails(self):
        with self.assertRaises(ValueError): await m.session_list('other', 'project-a')
        with self.assertRaises(ValueError): await m.session_status('other', 'project-a', 'id')

    async def test_outcome_refuses_missing_authorization_before_adapter(self):
        with patch.object(m, 'CodexAdapter', side_effect=AssertionError('should not call')):
            with self.assertRaises(PermissionError): await m.codex_session_outcome('project-a', 'id')

    async def test_claude_mutations_require_both_authorizations(self):
        with patch.object(m.claude_adapter, 'start_session', side_effect=AssertionError('should not call')):
            with self.assertRaises(PermissionError): await m.claude_start('p', 'work', authorized=True)
        with patch.object(m.claude_adapter, 'resume_session', side_effect=AssertionError('should not call')):
            with self.assertRaises(PermissionError): await m.claude_resume('p', 'id', 'work', model_use_authorized=True)
        with patch.object(m.claude_adapter, 'stop_session', side_effect=AssertionError('should not call')):
            with self.assertRaises(PermissionError): await m.claude_stop('p', 'id')
        with patch.object(m.claude_adapter, 'read_session_summary', side_effect=AssertionError('should not call')):
            with self.assertRaises(PermissionError): await m.claude_session_summary('p', 'id')
        with patch.object(m.claude_adapter, 'rename_session', side_effect=AssertionError('should not call')):
            with self.assertRaises(PermissionError): await m.claude_rename('p', 'id', 'name')
        with patch.object(m.claude_adapter, 'tag_session', side_effect=AssertionError('should not call')):
            with self.assertRaises(PermissionError): await m.claude_tag('p', 'id', 'tag')

    async def test_wakeup_discloses_no_dispatcher(self):
        result = await m.codex_wakeup_capability()
        self.assertFalse(result['automatic_wakeup_available'])
        self.assertFalse(result['queued'])


if __name__ == '__main__': unittest.main()
