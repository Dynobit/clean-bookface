#!/usr/bin/env python3
"""Isolated optional homeserver; all mutable/secret state lives outside source."""
import ipaddress
import argparse, hashlib, hmac, json, os, pathlib, re, secrets, socket, subprocess, sys, time, urllib.request, urllib.error
ROOT = pathlib.Path(__file__).resolve().parent

def write(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n' if not isinstance(value, str) else value)
    path.chmod(0o600)

def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def compose(state, *args, **kwargs):
    return run(['docker', 'compose', '-p', state['project'], '-f', str(state['runtime'] / 'compose.json'), *args], **kwargs)

def request(state, path, body=None, token=None, method=None):
    headers = {'Content-Type': 'application/json'}
    if token: headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(state['url'] + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        data = json.load(e)
        if e.code == 429 and e.headers.get('Retry-After', '').isdigit():
            data.setdefault('retry_after_ms', int(e.headers['Retry-After']) * 1000)
        return e.code, data

def ready(state):
    for _ in range(90):
        try:
            if request(state, '/_matrix/client/versions')[0] == 200: return
        except (OSError, ValueError): pass
        time.sleep(1)
    raise RuntimeError('Synapse failed readiness within 90 seconds; inspect exact project logs privately')

def login(state, username, password):
    status, data = request(state, '/_matrix/client/v3/login', {'type':'m.login.password', 'identifier': {'type':'m.id.user', 'user':username}, 'password':password})
    if status == 429 and 0 < data.get('retry_after_ms', 0) <= 60000:
        time.sleep(data['retry_after_ms'] / 1000 + 0.1)
        status, data = request(state, '/_matrix/client/v3/login', {'type':'m.login.password', 'identifier': {'type':'m.id.user', 'user':username}, 'password':password})
    if status != 200: raise RuntimeError('Login failed, HTTP ' + str(status))
    return data['access_token']

def invite(state, expiry=3600, admin_token=None):
    if not isinstance(expiry, int) or not 1 <= expiry <= 7 * 86400:
        raise ValueError('Invitation expiry must be between one second and seven days')
    admin = json.loads((state['runtime'] / 'admin.json').read_text())
    token = admin_token or login(state, admin['username'], admin['password'])
    status, data = request(state, '/_synapse/admin/v1/registration_tokens/new', {'uses_allowed':1, 'expiry_time':int((time.time()+expiry)*1000)}, token)
    if admin_token is None: request(state, '/_matrix/client/v3/logout', {}, token)
    if status != 200: raise RuntimeError('Invitation failed, HTTP ' + str(status))
    return data

def seed(state):
    if state['mode'] != 'local': raise RuntimeError('Fictional accounts are local-only')
    accounts = []
    admin = json.loads((state['runtime'] / 'admin.json').read_text())
    admin_token = login(state, admin['username'], admin['password'])
    for username in ['alice', 'bob', 'mallory']:
        invitation = invite(state, admin_token=admin_token)
        password = secrets.token_urlsafe(24)
        body = {'username':username, 'password':password, 'inhibit_login':True}
        status, challenge = request(state, '/_matrix/client/v3/register', body)
        if status != 401: raise RuntimeError('Registration did not require authentication')
        body['auth'] = {'type':'m.login.registration_token', 'session':challenge['session'], 'token':invitation['token']}
        status, result = request(state, '/_matrix/client/v3/register', body)
        if status == 401 and 'm.login.dummy' in [stage for flow in result.get('flows',[]) for stage in flow['stages']]:
            body['auth'] = {'type':'m.login.dummy', 'session':result['session']}
            status, result = request(state, '/_matrix/client/v3/register', body)
        if status != 200: raise RuntimeError('Invited registration failed, HTTP ' + str(status))
        accounts.append({'username':username, 'userId':result['user_id'], 'password':password})
    request(state, '/_matrix/client/v3/logout', {}, admin_token)
    write(state['runtime'] / 'fictional-credentials.json', accounts)

def federation_peer(value):
    """Accept an exact DNS Matrix server name (optionally written as HTTPS origin)."""
    raw = value[8:] if value.startswith('https://') else value
    if '/' in raw or '@' in raw or '?' in raw or '#' in raw:
        raise argparse.ArgumentTypeError('Peer must be a server name or HTTPS origin without path')
    match = re.fullmatch(r'([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?', raw)
    if not match or '..' in raw:
        raise argparse.ArgumentTypeError('Peer must be a lowercase DNS server name with optional port')
    hostname, port = match.groups()
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise argparse.ArgumentTypeError('Use a DNS server identity, not an IP address')
    if '.' not in hostname or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in hostname.split('.')):
        raise argparse.ArgumentTypeError('Peer must be a fully qualified DNS name')
    if port and not 1 <= int(port) <= 65535:
        raise argparse.ArgumentTypeError('Invalid peer port')
    return hostname + (':' + str(int(port)) if port else '')

def synapse_user():
    # The official entrypoint drops UID 0. Give root-run installs an explicit
    # unprivileged identity and make only their new /data tree readable by it.
    return '991:991' if os.getuid() == 0 else f'{os.getuid()}:{os.getgid()}'


def prepare_synapse_ownership(runtime, spec):
    if os.getuid() != 0:
        return
    identity = spec['services']['synapse']['user']
    if not re.fullmatch(r'[0-9]+:[0-9]+', identity):
        raise RuntimeError('Synapse requires an explicit numeric service identity')
    uid, gid = map(int, identity.split(':'))
    if uid == 0:
        raise RuntimeError('Refusing root Synapse service identity')
    directory = runtime / 'synapse'
    if directory.is_symlink() or not directory.is_dir():
        raise RuntimeError('Synapse data must be a real directory in the managed runtime')
    for path in [directory, *directory.rglob('*')]:
        os.chown(path, uid, gid, follow_symlinks=False)


def initialize(args):
    peers = sorted(set(federation_peer(p) for p in getattr(args, 'federation_peer', [])))
    test_rate_profile = getattr(args, 'test_rate_profile', False)
    if test_rate_profile and args.mode != 'local':
        raise RuntimeError('--test-rate-profile is restricted to disposable local qualification')
    runtime = args.runtime.resolve()
    if runtime == ROOT.parent or ROOT.parent in runtime.parents: raise RuntimeError('Runtime must be outside checkout')
    if runtime.exists(): raise RuntimeError('Bootstrap requires a new runtime directory')
    pins = json.loads((ROOT / 'images.json').read_text())
    for image in pins.values():
        if not re.fullmatch(r'[^\s]+:[^\s@]+@sha256:[a-f0-9]{64}', image): raise RuntimeError('Image lock incomplete: resolve official registry digests first')
    if args.imported_images:
        if args.mode != 'local': raise RuntimeError('Imported image qualification is local-only')
        pins = json.loads((ROOT / 'imported-images.json').read_text())
        for image in pins.values():
            run(['docker','image','inspect',image], stdout=subprocess.DEVNULL)
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]+', args.server_name): raise RuntimeError('Invalid server name')
    url = args.public_url or f'http://127.0.0.1:{args.port}'
    if args.mode == 'production' and not url.startswith('https://'): raise RuntimeError('Production requires --public-url https://...')
    with socket.socket() as sock: sock.bind(('127.0.0.1', args.port))
    runtime.mkdir(mode=0o700, parents=True)
    (runtime / 'synapse').mkdir(mode=0o700)
    state = {'runtime':runtime, 'project':'cbf-e2ee-'+secrets.token_hex(5), 'mode':args.mode, 'testRateProfile':test_rate_profile, 'federationPeers':peers, 'url':f'http://127.0.0.1:{args.port}'}
    password, shared = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    write(runtime / 'postgres-password', password)
    config = {'server_name':args.server_name, 'public_baseurl':url+'/', 'report_stats':False,
      'listeners':[{'port':8008,'tls':False,'type':'http','x_forwarded':args.mode=='production','resources':[{'names':['client','federation'] if peers else ['client'],'compress':False}]}],
      'database':{'name':'psycopg2','args':{'user':'synapse','password':password,'database':'synapse','host':'postgres','cp_min':2,'cp_max':5}},
      'log_config':'/data/log.config','media_store_path':'/data/media_store','signing_key_path':'/data/server.signing.key','pid_file':'/data/homeserver.pid',
      'macaroon_secret_key':secrets.token_urlsafe(32),'form_secret':secrets.token_urlsafe(32),
      'registration_shared_secret':shared,'enable_registration':True,'registration_requires_token':True,
      'allow_guest_access':False,'url_preview_enabled':False,'enable_metrics':False,'enable_presence':False,
      'federation_domain_whitelist':peers, 'trusted_key_servers':[], 'suppress_key_server_warning':True,
      'allow_public_rooms_over_federation':False,'allow_public_rooms_without_auth':False,
      'room_list_publication_rules':[{'action':'deny'}],
      'user_directory':{'enabled':False,'search_all_users':False}, 'enable_3pid_lookup':False,
      'account_threepid_delegates':{},'default_identity_server':'', 'max_upload_size':'25M',
      'rc_registration':{'per_second':0.17,'burst_count':10}}
    if test_rate_profile:
        config['rc_login'] = {'address':{'per_second':10,'burst_count':200},'account':{'per_second':10,'burst_count':200}}
    write(runtime / 'synapse/log.config', {'version':1,'handlers':{'console':{'class':'logging.StreamHandler'}},'root':{'level':'WARNING','handlers':['console']},'loggers':{'synapse.access.http':{'level':'ERROR'}}})
    write(runtime / 'synapse/homeserver.yaml', config)
    spec = {'services':{
      'postgres':{'image':pins['postgres'],'environment':{'POSTGRES_USER':'synapse','POSTGRES_DB':'synapse','POSTGRES_PASSWORD_FILE':'/run/secrets/postgres-password','POSTGRES_INITDB_ARGS':'--encoding=UTF8 --locale=C'},'secrets':['postgres-password'],'volumes':['postgres:/var/lib/postgresql/data'],'networks':['private'],'healthcheck':{'test':['CMD-SHELL','pg_isready -h 127.0.0.1 -U synapse -d synapse'],'interval':'3s','timeout':'3s','retries':30},'restart':'unless-stopped' if args.mode == 'production' else 'no'},
      'synapse':{'image':pins['synapse'],'user':synapse_user(),'environment':{'SYNAPSE_CONFIG_PATH':'/data/homeserver.yaml'},'volumes':[str(runtime / 'synapse')+':/data'],'ports':[f'127.0.0.1:{args.port}:8008'],'networks':['private','client'],'depends_on':{'postgres':{'condition':'service_healthy'}},'restart':'unless-stopped' if args.mode == 'production' else 'no'}},
      'secrets':{'postgres-password':{'file':str(runtime/'postgres-password')}},'volumes':{'postgres':{}},'networks':{'private':{'internal':True},'client':{}}}
    for name, memory, pids in [('synapse', '1536m', 256), ('postgres', '768m', 128)]:
        spec['services'][name].update(cap_drop=['ALL'], security_opt=['no-new-privileges:true'],
                                     mem_limit=memory, pids_limit=pids,
                                     logging={'driver':'json-file','options':{'max-size':'10m','max-file':'3'}})
    # Official postgres entrypoint initializes/chowns its named volume as root,
    # then uses gosu; these are the only retained bootstrap capabilities.
    spec['services']['postgres']['cap_add'] = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID']
    prepare_synapse_ownership(runtime, spec)
    write(runtime/'compose.json',spec)
    write(runtime/'state.json',{**state,'runtime':str(runtime)})
    write(runtime/'client-config.json',{'homeserverUrl':url,'serverName':args.server_name,'federationPolicy':'explicit-peers' if peers else 'disabled', 'federationPeers':peers})
    compose(state,'up','-d'); ready(state)
    admin_password = secrets.token_urlsafe(32)
    status, nonce = request(state,'/_synapse/admin/v1/register')
    if status != 200: raise RuntimeError('Admin bootstrap unavailable')
    payload = {'nonce':nonce['nonce'],'username':'host_admin','password':admin_password,'admin':True}
    payload['mac'] = hmac.new(shared.encode(), '\0'.join([nonce['nonce'],'host_admin',admin_password,'admin']).encode(),hashlib.sha1).hexdigest()
    status, created = request(state,'/_synapse/admin/v1/register',payload)
    if status != 200: raise RuntimeError('Admin creation failed')
    request(state,'/_matrix/client/v3/logout',{},created['access_token'])
    write(runtime/'admin.json',{'username':'host_admin','password':admin_password})
    del config['registration_shared_secret']; write(runtime/'synapse/homeserver.yaml',config)
    compose(state,'restart','synapse'); ready(state)
    if args.mode == 'local': seed(state)
    print('Initialized isolated project; credentials remain in runtime files. Client endpoint: '+url)

def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['bootstrap','status','start','stop','destroy-local','invite','check'])
    parser.add_argument('--runtime',type=pathlib.Path,required=True)
    parser.add_argument('--federation-peer',action='append',type=federation_peer,default=[],help='Opt-in exact Matrix peer server name or HTTPS origin; repeat for each peer; default is closed')
    parser.add_argument('--test-rate-profile',action='store_true',help='Local-only: bounded higher successful-login/address capacity for browser automation; failed-login limits unchanged')
    parser.add_argument('--imported-images',action='store_true',help='Local-only, verified official imported manifest digests after save/load')
    parser.add_argument('--mode',choices=['local','production'],default='local')
    parser.add_argument('--expiry-hours', type=int, default=1)
    parser.add_argument('--server-name',default='encrypted.test'); parser.add_argument('--public-url'); parser.add_argument('--port',type=int,default=18008)
    args=parser.parse_args()
    if args.action=='bootstrap': return initialize(args)
    state=json.loads((args.runtime/'state.json').read_text()); state['runtime']=args.runtime.resolve()
    if not re.fullmatch(r'cbf-e2ee-[a-f0-9]{10}',state['project']): raise RuntimeError('Invalid project marker')
    if args.action=='status':
        compose(state,'ps')
        import operations
        print('Backup health:',json.dumps(operations.health(state)))
        print('Client HTTP status:',request(state,'/_matrix/client/versions')[0])
    elif args.action=='start': compose(state,'up','-d'); ready(state)
    elif args.action=='stop': compose(state,'stop')
    elif args.action=='destroy-local':
        if state['mode']!='local': raise RuntimeError('Refusing production volume deletion')
        compose(state,'down','--volumes'); print('Exact local project removed; runtime secret files retained for explicit operator deletion')
    elif args.action=='invite':
        write(state['runtime']/'invitation.json',invite(state, expiry=args.expiry_hours * 3600)); print('Single-use invitation with selected expiry saved privately in runtime/invitation.json')
    elif args.action=='check':
        assert request(state,'/_matrix/client/versions')[0]==200
        code,data=request(state,'/_matrix/client/v3/register',{'username':'uninvited','password':secrets.token_urlsafe(20)})
        assert code==401 and all('m.login.registration_token' in f['stages'] for f in data['flows'])
        assert request(state,'/_matrix/client/v3/register?kind=guest',{})[0]==403
        assert request(state,'/_matrix/federation/v1/version')[0]==(200 if state.get('federationPeers') else 404)
        assert request(state,'/_matrix/client/v3/publicRooms')[0] in (401,403)
        print('PASS: readiness, token-only registration, guest denial, configured federation listener, unauthenticated room directory denied')

if __name__=='__main__':
    try: main()
    except (RuntimeError, subprocess.CalledProcessError, OSError) as exc:
        print(type(exc).__name__+': '+str(exc),file=sys.stderr); sys.exit(1)
