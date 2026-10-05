#!/usr/bin/env python3
"""Disposable two-home protocol test. Not a browser E2EE qualification.

No host CA installation or host DNS changes. Only generated Docker projects.
"""
import argparse
import base64
import hashlib
import json
import ipaddress
import os
import pathlib
import secrets
import subprocess
import time
import urllib.request
import host


def persist_fixture_network(runtime, network, identity, address):
    """Bind only the generated Synapse service to its private fixture network."""
    path=runtime/'compose.json'
    config=json.loads(path.read_text())
    networks=config['services']['synapse']['networks']
    if isinstance(networks,list): networks={name:{} for name in networks}
    networks['federation_fixture']={'aliases':[identity],'ipv4_address':address}
    config['services']['synapse']['networks']=networks
    config['networks']['federation_fixture']={'external':True,'name':network}
    host.write(path,config)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=pathlib.Path, required=True)
    parser.add_argument('--port', type=int, default=18030)
    parser.add_argument('--keep-running', action='store_true', help='Retain only these disposable homes for browser qualification')
    args = parser.parse_args()
    root = args.runtime.resolve()
    if root.exists() or root == host.ROOT.parent or host.ROOT.parent in root.parents:
        raise RuntimeError('Use a new runtime outside source')
    os.umask(0o077)
    root.mkdir(mode=0o700, parents=True)
    network = 'cbf-fed-' + secrets.token_hex(5)
    identities = {name: name+'-'+network.removeprefix('cbf-fed-')+'.test' for name in ['a','b']}
    states = []
    network_created = False
    passed = False
    proof = {'scope':'two disposable independent homes; protocol transport only', 'checks':[]}
    def run(argv):
        return subprocess.run(argv, check=True, capture_output=True, text=True).stdout.strip()
    def check(value, label):
        if not value: raise AssertionError(label)
        proof['checks'].append(label)
        print('PASS:', label, flush=True)
    try:
        # Fresh CA and two leaf certificates never leave this private fixture directory.
        run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(root/'ca.key'),'-out',str(root/'ca.pem'),'-days','2','-subj','/CN=Disposable federation fixture CA'])
        for name in ['a','b']:
            run(['openssl','req','-newkey','rsa:2048','-nodes','-keyout',str(root/(name+'.key')),'-out',str(root/(name+'.csr')),'-subj','/CN='+identities[name]])
            host.write(root/(name+'.ext'), 'subjectAltName=DNS:'+identities[name]+'\nextendedKeyUsage=serverAuth\n')
            run(['openssl','x509','-req','-in',str(root/(name+'.csr')),'-CA',str(root/'ca.pem'),'-CAkey',str(root/'ca.key'),'-CAcreateserial','-out',str(root/(name+'.pem')),'-days','2','-extfile',str(root/(name+'.ext'))])
        run(['docker','network','create','--internal',network]); network_created = True
        for i, name in enumerate(['a','b']):
            peer = identities['b' if name == 'a' else 'a']
            options = argparse.Namespace(runtime=root/name, mode='local', server_name=identities[name], public_url=None, port=args.port+i, imported_images=True, test_rate_profile=True, federation_peer=[peer] if name == 'a' else [])
            host.initialize(options)
            state=json.loads((root/name/'state.json').read_text()); state['runtime']=root/name
            states.append(state)
        a,b=states
        check(host.request(b,'/_matrix/federation/v1/version')[0] == 404, 'default-closed home has no federation endpoint')
        check(json.loads((b['runtime']/'synapse/homeserver.yaml').read_text())['federation_domain_whitelist'] == [], 'default-closed home retains empty peer allowlist')
        # Persist the shared network in Compose: manual network connect is lost
        # whenever Compose recreates a container. Explicit IPAM keeps the exact
        # test-only SSRF exceptions valid across down/up as well.
        details=json.loads(run(['docker','network','inspect',network]))[0]
        subnet=details['IPAM']['Config'][0]['Subnet']
        run(['docker','network','rm',network])
        run(['docker','network','create','--internal','--subnet',subnet,network])
        ips=[str(ipaddress.ip_network(subnet)[i]) for i in [2,3]]
        for i,(name,state) in enumerate(zip(['a','b'],states)):
            persist_fixture_network(state['runtime'],network,identities[name],ips[i])
            host.compose(state,'up','-d','synapse'); host.ready(state)
        for i,(name,state) in enumerate(zip(['a','b'],states)):
            data=state['runtime']/'synapse'
            for src,dst in [(root/'ca.pem',data/'fixture-ca.pem'),(root/(name+'.pem'),data/'fixture-cert.pem'),(root/(name+'.key'),data/'fixture-key.pem')]:
                host.write(dst,src.read_text())
            config=json.loads((data/'homeserver.yaml').read_text())
            config['listeners'].append({'port':8448,'tls':True,'type':'http','resources':[{'names':['federation'],'compress':False}]})
            config.update(tls_certificate_path='/data/fixture-cert.pem',tls_private_key_path='/data/fixture-key.pem',federation_custom_ca_list=['/data/fixture-ca.pem'])
            # Exact private peer address exception ONLY in this disposable fixture.
            # Keep all default blocklists and TLS verification in force.
            config['ip_range_whitelist']=[ips[1-i]+'/32']
            # B starts with its closed allowlist, despite the TLS test listener.
            host.write(data/'homeserver.yaml',config)
            host.compose(state,'restart','synapse'); host.ready(state)
        for state in states:
            host.compose(state,'down')
            host.compose(state,'up','-d'); host.ready(state)
        for i,(name,state) in enumerate(zip(['a','b'],states)):
            cid=run(['docker','compose','-p',state['project'],'-f',str(state['runtime']/'compose.json'),'ps','-q','synapse'])
            attached=json.loads(run(['docker','inspect',cid]))[0]['NetworkSettings']['Networks'][network]
            if attached['IPAddress'] != ips[i] or identities[name] not in attached['Aliases']:
                raise AssertionError('Recreated federation topology changed')
        check(True,'Compose down/up recreated both homes with persistent federation topology')
        accounts=[json.loads((s['runtime']/'fictional-credentials.json').read_text())[0] for s in states]
        tokens=[host.login(s,u['username'],u['password']) for s,u in zip(states,accounts)]
        code,room=host.request(a,'/_matrix/client/v3/createRoom',{'preset':'private_chat','initial_state':[{'type':'m.room.encryption','state_key':'','content':{'algorithm':'m.megolm.v1.aes-sha2'}}]},tokens[0])
        check(code==200,'encrypted room created on first independent home')
        rid=room['room_id']
        code,result=host.request(a,'/_matrix/client/v3/rooms/'+rid+'/invite',{'user_id':accounts[1]['userId']},tokens[0])
        proof['closedInviteStatus']=code
        check(code == 403,'default-closed peer rejects actual remote invitation over TLS')
        # Enable B's explicit reciprocal peer and refresh only these two containers.
        config_path=b['runtime']/'synapse/homeserver.yaml'
        config=json.loads(config_path.read_text()); config['federation_domain_whitelist']=[identities['a']]
        config['listeners'][0]['resources'][0]['names']=['client','federation']
        host.write(config_path,config)
        b['federationPeers']=[identities['a']]
        host.write(b['runtime']/'state.json',{**b,'runtime':str(b['runtime'])})
        client=json.loads((b['runtime']/'client-config.json').read_text())
        client.update(federationPolicy='explicit-peers',federationPeers=[identities['a']])
        host.write(b['runtime']/'client-config.json',client)
        for state in states:
            host.compose(state,'restart','synapse'); host.ready(state)
        code,result=host.request(a,'/_matrix/client/v3/rooms/'+rid+'/invite',{'user_id':accounts[1]['userId']},tokens[0])
        check(code==200,'allowlisted remote invitation delivered')
        code,result=host.request(b,'/_matrix/client/v3/join/'+rid,{},tokens[1])
        check(code==200,'second independent home joined encrypted room')
        code,encryption=host.request(b,'/_matrix/client/v3/rooms/'+rid+'/state/m.room.encryption/',token=tokens[1])
        check(code==200 and encryption.get('algorithm')=='m.megolm.v1.aes-sha2','remote room retains required encryption state')
        # Random opaque bytes deliberately are NOT claimed as real Megolm encryption.
        ciphertext=base64.b64encode(secrets.token_bytes(128)).decode()
        event={'algorithm':'m.megolm.v1.aes-sha2','ciphertext':ciphertext,'session_id':'fixture-opaque-session','device_id':'FIXTURE','sender_key':base64.b64encode(secrets.token_bytes(32)).decode()}
        code,sent=host.request(a,'/_matrix/client/v3/rooms/'+rid+'/send/m.room.encrypted/fixture1',event,tokens[0],method='PUT')
        check(code==200,'opaque m.room.encrypted event accepted')
        received=None
        for _ in range(30):
            code,received=host.request(b,'/_matrix/client/v3/rooms/'+rid+'/event/'+sent['event_id'],token=tokens[1])
            if code==200: break
            time.sleep(1)
        check(code==200 and received['type']=='m.room.encrypted' and received['content']==event,'ciphertext event relayed exactly to second home')
        blob=secrets.token_bytes(8192)
        req=urllib.request.Request(a['url']+'/_matrix/media/v3/upload',data=blob,headers={'Authorization':'Bearer '+tokens[0],'Content-Type':'application/octet-stream'},method='POST')
        with urllib.request.urlopen(req,timeout=30) as response: media=json.load(response)['content_uri']
        origin,media_id=media.removeprefix('mxc://').split('/',1)
        req=urllib.request.Request(b['url']+'/_matrix/client/v1/media/download/'+origin+'/'+media_id,headers={'Authorization':'Bearer '+tokens[1]})
        with urllib.request.urlopen(req,timeout=30) as response: relayed=response.read()
        check(relayed==blob,'opaque attachment fetched through second home using authenticated federation media')
        proof['mediaSha256']=hashlib.sha256(blob).hexdigest()
        proof['homes']=[{'identity':identities[n],'url':s['url']} for n,s in zip(['a','b'],states)]
        proof['limits']=['Random ciphertext protocol fixture, not valid client-encrypted Megolm or attachment data','No browser identity verification, key exchange, decryption or recovery qualification','Same-machine Docker TLS test; no production DNS, HTTPS proxy, firewall or offsite availability qualification']
        passed=True
    except Exception as exc:
        proof['failure']=type(exc).__name__+': '+str(exc)
        raise
    finally:
        proof['passed']=passed
        host.write(root/'qualification.json',proof)
        if not (args.keep_running and passed):
            # Include partially bootstrapped projects if initialization failed after creation.
            for name in ['a','b']:
                path=root/name/'state.json'
                if path.exists() and not any(s['runtime']==root/name for s in states):
                    state=json.loads(path.read_text()); state['runtime']=root/name; states.append(state)
            for state in reversed(states): host.compose(state,'down','--volumes')
            if network_created: run(['docker','network','rm',network])
        else:
            host.write(root/'fixture-network.json',{'network':network})
        print('Private evidence:',root/'qualification.json',flush=True)

if __name__=='__main__': main()
