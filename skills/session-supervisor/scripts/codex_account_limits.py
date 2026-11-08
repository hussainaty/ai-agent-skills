"""Read sanitized Codex account limit windows without consuming credits."""
from __future__ import annotations
import math,os,subprocess,time
from typing import Any
from codex_session_metadata import _validate_command,_validate_timeout,_JsonLineReader,_send,_wait_for_response,_cleanup_process


def _number(value):
    return value if isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) else None


def _window(value):
    if not isinstance(value,dict): return None
    return {key:_number(value.get(key)) for key in ("usedPercent","windowDurationMins","resetsAt")}


def _bucket(value):
    if not isinstance(value,dict): return None
    return {"limitId":value.get("limitId") if isinstance(value.get("limitId"),str) else None,
            "primary":_window(value.get("primary")),"secondary":_window(value.get("secondary")),
            "rateLimitReachedType":value.get("rateLimitReachedType") if isinstance(value.get("rateLimitReachedType"),str) else None}


def read_limits(*, command: Any=None, timeout: float=30):
    argv=_validate_command(command);deadline=time.monotonic()+_validate_timeout(timeout)
    flags=getattr(subprocess,"CREATE_NO_WINDOW",0) if os.name=="nt" else 0
    process=None
    try:
        process=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
            shell=False,text=True,encoding="utf-8",errors="replace",bufsize=1,creationflags=flags)
        if process.stdin is None or process.stdout is None: raise OSError("app-server pipes unavailable")
        reader=_JsonLineReader(process.stdout);reader.start()
        _send(process,{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"cross_agent_limits","version":"0.1"}}})
        if not isinstance(_wait_for_response(reader,1,deadline),dict): raise RuntimeError("malformed initialize result")
        _send(process,{"jsonrpc":"2.0","method":"initialized","params":{}})
        _send(process,{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}})
        result=_wait_for_response(reader,2,deadline)
        if not isinstance(result,dict): raise RuntimeError("malformed limits response")
        primary=_bucket(result.get("rateLimits"))
        raw=result.get("rateLimitsByLimitId")
        buckets={key:_bucket(value) for key,value in raw.items() if isinstance(key,str) and isinstance(value,dict)} if isinstance(raw,dict) else {}
        return {"rate_limits":primary,"by_limit_id":buckets,"note":"Read-only; resets and availability may change. No credits were consumed."}
    finally:
        _cleanup_process(process)
