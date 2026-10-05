#!/usr/bin/env python3
"""Real invitation admission checks. Only disposable local installations."""
import json, pathlib, secrets, sys, time
from host import invite, login, request, write
state=json.loads((pathlib.Path(sys.argv[1])/'state.json').read_text())
state['runtime']=pathlib.Path(sys.argv[1])
assert state['mode']=='local'
def registration(token, username):
    body={'username':username,'password':secrets.token_urlsafe(24),'inhibit_login':True}
    status,result=request(state,'/_matrix/client/v3/register',body)
    assert status==401,(status,'challenge')
    body['auth']={'type':'m.login.registration_token','session':result['session'],'token':token}
    status,result=request(state,'/_matrix/client/v3/register',body)
    if status==401 and 'm.login.registration_token' in result.get('completed',[]):
        body['auth']={'type':'m.login.dummy','session':result['session']}
        status,result=request(state,'/_matrix/client/v3/register',body)
    return status,result
admin=json.loads((state['runtime']/'admin.json').read_text())
admin_token=login(state,admin['username'],admin['password'])
single=invite(state,admin_token=admin_token)
assert registration(single['token'],'invited_'+secrets.token_hex(4))[0]==200
status,result=registration(single['token'],'reuse_'+secrets.token_hex(4))
assert status in (401,403) and result.get('errcode') in ('M_UNAUTHORIZED','M_FORBIDDEN'),(status,result.get('errcode'))
expired=invite(state,expiry=1,admin_token=admin_token)
request(state,'/_matrix/client/v3/logout',{},admin_token)
time.sleep(1.1)
status,result=registration(expired['token'],'expired_'+secrets.token_hex(4))
assert status in (401,403) and result.get('errcode') in ('M_UNAUTHORIZED','M_FORBIDDEN'),(status,result.get('errcode'))
assert request(state,'/_synapse/admin/v1/register',{})[0] == 400
assert 'registration_shared_secret' not in json.loads((state['runtime']/'synapse/homeserver.yaml').read_text())
account=json.loads((state['runtime']/'fictional-credentials.json').read_text())[0]
access=login(state,account['username'],account['password'])
code,room=request(state,'/_matrix/client/v3/createRoom',{'visibility':'private','preset':'private_chat'},access)
assert code==200
assert request(state,'/_matrix/client/v3/directory/list/room/'+room['room_id'],{'visibility':'public'},access,method='PUT')[0]==403
assert request(state,'/_matrix/client/v3/user_directory/search',{'search_term':'bob'},access)[1]['results']==[]
request(state,'/_matrix/client/v3/logout',{},access)
print('PASS: room publication denied and user directory search empty')
print('PASS: actual invited registration, consumed token rejected, expired token rejected, shared-secret bootstrap disabled')
