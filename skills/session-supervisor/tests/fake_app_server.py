import json,sys,time,os
for line in sys.stdin:
 try: msg=json.loads(line)
 except ValueError: continue
 method=msg.get("method")
 if method=="initialize":
  print(json.dumps({"id":msg["id"],"result":{"userAgent":"fake"}}),flush=True)
 elif method=="thread/list":
  if "appServer" not in msg["params"].get("sourceKinds",[]):
   print(json.dumps({"id":msg["id"],"error":{"code":-32602}}),flush=True); continue
  d=msg["params"]["cwd"]
  rows=[{"id":"good","name":"project session","cwd":d,"updatedAt":10,"status":{"type":"idle"},"preview":"private test content"},
        {"id":"other","name":"wrong","cwd":d+"-other","preview":"private content"}]
  print(json.dumps({"method":"notice","params":{}}),flush=True)
  print(json.dumps({"id":msg["id"],"result":{"data":rows,"nextCursor":None}}),flush=True)

 elif method=="thread/start":
  print(json.dumps({"id":msg["id"],"result":{"thread":{"id":"new-session","cwd":msg["params"]["cwd"],"preview":"private synthetic content","ephemeral":msg["params"].get("ephemeral",False)}}}),flush=True)

 elif method=="thread/read":
  thread_id=msg["params"]["threadId"]
  d=os.environ.get("TEST_SESSION_PROJECT","")
  if thread_id=="wrong-project": d=d+"-other"
  print(json.dumps({"id":msg["id"],"result":{"thread":{"id":thread_id,"cwd":d,"name":"synthetic","status":{"type":"idle"},"preview":"private synthetic content"}}}),flush=True)
 elif method=="thread/turns/list":
  assert msg["params"].get("itemsView")=="notLoaded"
  print(json.dumps({"id":msg["id"],"result":{"data":[{"id":"turn-one","status":"completed","items":[{"text":"private synthetic content"}]}]}}),flush=True)

 elif method=="thread/items/list":
  assert msg["params"].get("turnId")=="turn-one"
  items=[{"turnId":"other-turn","item":{"type":"agentMessage","text":"wrong scope"}},
         {"turnId":"turn-one","item":{"type":"agentMessage","text":"synthetic result","phase":"final_answer"}}]
  print(json.dumps({"id":msg["id"],"result":{"data":items,"nextCursor":None}}),flush=True)

 elif method=="thread/goal/get":
  thread_id=msg["params"]["threadId"]
  goal=None if thread_id=="no-goal" else {"threadId":thread_id,"status":"active","objective":"private synthetic objective","tokenBudget":100,"tokensUsed":25,"timeUsedSeconds":10}
  print(json.dumps({"id":msg["id"],"result":{"goal":goal}}),flush=True)

 elif method=="account/rateLimits/read":
  result={"rateLimits":{"limitId":"codex","primary":{"usedPercent":95,"windowDurationMins":60,"resetsAt":123456},"secondary":None,"credit":"private synthetic"},"rateLimitsByLimitId":{},"private":"do not return"}
  print(json.dumps({"id":msg["id"],"result":result}),flush=True)
