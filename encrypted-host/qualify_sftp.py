#!/usr/bin/env python3
"""Actual SFTP recovery fixture; requires a dedicated prepared disposable sshd container.

The pinned Debian container must have no mounts/published ports and run only
`sh -c 'sleep 3600'`, with openssh-server installed. This tool consumes/removes it.
No real SSH keys or host SSH configuration are used.
"""
import argparse
import hashlib
import json
import os
import pathlib
import secrets
import subprocess
import sys
import time
import urllib.request
import host
import recovery

DEBIAN='sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818'


def host_key_refused(result):
    # Restic can close the subprocess stderr pipe after SSH exits, before its
    # final diagnostic line is drained. Both messages identify strict key refusal.
    return result.returncode != 0 and any(message in result.stderr for message in (
        'Host key verification failed', 'REMOTE HOST IDENTIFICATION HAS CHANGED!'))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime',type=pathlib.Path,required=True)
    p.add_argument('--prepared-container',required=True)
    p.add_argument('--port',type=int,default=18100)
    a=p.parse_args();os.umask(0o077)
    root=recovery.outside_source(a.runtime)
    if root.exists():raise RuntimeError('Runtime must be new')
    container=a.prepared_container
    info=json.loads(subprocess.check_output(['docker','inspect',container]))[0]
    if not container.startswith('cbf-sftp-qual-') or info['Image']!=DEBIAN or info['Mounts'] or info['HostConfig']['PortBindings'] or info['Config']['Cmd']!=['-c','sleep 3600']:
        raise RuntimeError('Requires dedicated unmounted, unpublished, pinned Debian sleeping fixture')
    root.mkdir(mode=0o700,parents=True)
    proof={'checks':[],'serverBaseImage':DEBIAN};states=[];passed=False
    def run(argv,**kwargs):return subprocess.run(argv,check=True,**kwargs)
    def server(*argv,**kwargs):return run(['docker','exec',container,*argv],**kwargs)
    def check(value,label):
        if not value:raise AssertionError(label)
        proof['checks'].append(label);print('PASS:',label,flush=True)
    try:
        proof['opensshVersion']=subprocess.check_output(['docker','exec',container,'dpkg-query','-W','-f=${Version}','openssh-server'],text=True)
        ssh=root/'ssh';ssh.mkdir(mode=0o700)
        for name in ['client','server','wrong']:
            run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(root/name)])
        host.write(ssh/'id_ed25519',(root/'client').read_text())
        ip=info['NetworkSettings']['Networks']['bridge']['IPAddress']
        host.write(ssh/'known_hosts',f'[{ip}]:2222 '+(root/'server.pub').read_text())
        host.write(root/'sshd_config','\n'.join(['Port 2222','ListenAddress 0.0.0.0','HostKey /fixture/server','PidFile /fixture/sshd.pid','AuthorizedKeysFile /fixture/authorized_keys','PasswordAuthentication no','KbdInteractiveAuthentication no','PermitRootLogin no','UsePAM no','AllowUsers cbfbackup','AllowTcpForwarding no','X11Forwarding no','PermitTunnel no','ForceCommand internal-sftp','ChrootDirectory /srv/sftp','Subsystem sftp internal-sftp'])+'\n')
        server('sh','-c','mkdir -p /fixture /run/sshd /srv/sftp/backup; useradd -M -d /backup -s /usr/sbin/nologin cbfbackup; passwd -d cbfbackup; chown cbfbackup:cbfbackup /srv/sftp/backup',stdout=subprocess.DEVNULL)
        for source,target in [(root/'server','server'),(root/'client.pub','authorized_keys'),(root/'sshd_config','sshd_config')]:
            run(['docker','cp',str(source),container+':/fixture/'+target],stdout=subprocess.DEVNULL)
        server('chown','-R','root:root','/fixture')
        server('chmod','755','/fixture')
        server('chmod','644','/fixture/authorized_keys')
        server('/usr/sbin/sshd','-f','/fixture/sshd_config','-E','/fixture/sshd.log')
        options=argparse.Namespace(runtime=root/'primary',mode='local',server_name='sftp-'+secrets.token_hex(5)+'.test',public_url=None,port=a.port,imported_images=True,test_rate_profile=True,federation_peer=[])
        host.initialize(options)
        primary=json.loads((options.runtime/'state.json').read_text());primary['runtime']=options.runtime;states.append(primary)
        account=json.loads((options.runtime/'fictional-credentials.json').read_text())[0]
        access=host.login(primary,account['username'],account['password'])
        key,iv=secrets.token_hex(32),secrets.token_hex(16)
        plain=b'Fictional encrypted SFTP restore qualification.\n'+secrets.token_bytes(32768)
        encrypted=subprocess.run(['openssl','enc','-aes-256-ctr','-K',key,'-iv',iv],input=plain,capture_output=True,check=True).stdout
        req=urllib.request.Request(primary['url']+'/_matrix/media/v3/upload',data=encrypted,headers={'Authorization':'Bearer '+access,'Content-Type':'application/octet-stream'},method='POST')
        with urllib.request.urlopen(req,timeout=30) as response: media=json.load(response)['content_uri']
        host.write(root/'restic-password',secrets.token_urlsafe(32))
        common=['--runtime',str(options.runtime),'--sftp-host',ip,'--sftp-port','2222','--sftp-user','cbfbackup','--sftp-path','/backup/repository','--ssh-directory',str(ssh),'--password-file',str(root/'restic-password')]
        def recover(action,*extra,expect_success=True):
            before=time.monotonic()
            logpath = root/(action+'-'+secrets.token_hex(3)+'.log')
            with logpath.open('w') as log:
                result=subprocess.run([sys.executable,str(host.ROOT/'recovery.py'),action,*common,*extra],stdout=log,stderr=subprocess.STDOUT,timeout=180)
            result.stderr = logpath.read_text()
            if expect_success and result.returncode:raise RuntimeError(action+' failed; inspect private runtime log')
            return result,time.monotonic()-before
        correct=(ssh/'known_hosts').read_text()
        host.write(ssh/'known_hosts',f'[{ip}]:2222 '+(root/'wrong.pub').read_text())
        failed,_=recover('init-repository',expect_success=False)
        check(host_key_refused(failed),'strict incorrect SSH host key rejected')
        host.write(ssh/'known_hosts',correct)
        recover('init-repository');check(True,'actual SFTP restic repository initialized')
        _,elapsed=recover('backup');proof['routineBackupSeconds']=round(elapsed,2)
        check(host.request(primary,'/_matrix/client/versions')[0]==200,'routine SFTP backup/full-data check resumed primary')
        recover('backup','--leave-stopped')
        running=host.compose(primary,'ps','--status','running','--services',capture_output=True,text=True).stdout.splitlines()
        check('synapse' not in running,'restore-drill backup left source fenced')
        destination=root/'standby'
        _,elapsed=recover('restore-local','--destination',str(destination),'--port',str(a.port+1));proof['restoreSeconds']=round(elapsed,2)
        standby=json.loads((destination/'state.json').read_text());standby['runtime']=destination;states.append(standby)
        check((destination/'synapse/server.signing.key').read_bytes()==(options.runtime/'synapse/server.signing.key').read_bytes(),'SFTP restore preserved exact server signing identity')
        restored_access=host.login(standby,account['username'],account['password'])
        origin,media_id=media.removeprefix('mxc://').split('/',1)
        req=urllib.request.Request(standby['url']+'/_matrix/client/v1/media/download/'+origin+'/'+media_id,headers={'Authorization':'Bearer '+restored_access})
        with urllib.request.urlopen(req,timeout=30) as response: restored_bytes=response.read()
        check(restored_bytes==encrypted,'restored authenticated media matches encrypted bytes')
        decrypted=subprocess.run(['openssl','enc','-d','-aes-256-ctr','-K',key,'-iv',iv],input=restored_bytes,capture_output=True,check=True).stdout
        check(decrypted==plain,'restored media decrypts exactly with fixture-only client key')
        proof['mediaSha256']=hashlib.sha256(encrypted).hexdigest()
        proof['mediaBytes']=len(encrypted)
        proof['limits']=['Same-machine disposable SFTP endpoint; not physical offsite recovery','AES-CTR fixture media, not browser Matrix key-recovery qualification','No provider admission, quota, retention or scheduled backup qualification']
        passed=True
    except Exception as exc:
        proof['failure']=type(exc).__name__+': '+str(exc);raise
    finally:
        proof['passed']=passed;host.write(root/'qualification.json',proof)
        for name in ['primary','standby']:
            path=root/name/'state.json'
            if path.exists() and not any(s['runtime']==root/name for s in states):
                state=json.loads(path.read_text());state['runtime']=root/name;states.append(state)
        subprocess.run(['docker','cp',container+':/fixture/sshd.log',str(root/'sshd.log')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        for state in reversed(states):host.compose(state,'down','--volumes')
        run(['docker','rm','-f',container],stdout=subprocess.DEVNULL)
        print('Private evidence:',root/'qualification.json',flush=True)

if __name__=='__main__':main()
