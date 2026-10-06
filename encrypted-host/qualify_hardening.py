#!/usr/bin/env python3
"""Disposable local host: resource readback, staged backup/restore, retention.

Run after host.py bootstrap --mode local in a fresh runtime. Never production.
Creates a private sibling evidence directory; removes only its own standby.
The caller owns primary cleanup. All data must be synthetic.
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import subprocess
import sys
import time
import host
import operations
import recovery


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime',required=True,type=pathlib.Path)
    parser.add_argument('--standby-port',type=int,default=18374)
    args=parser.parse_args()
    state=operations.load(args.runtime)
    if state['mode'] != 'local': raise RuntimeError('Disposable local qualification only')
    evidence=state['runtime'].with_name(state['runtime'].name+'-hardening')
    evidence.mkdir(mode=0o700)
    password=evidence/'password'; host.write(password,'synthetic-hardening-fixture-password')
    config={'repository':str(evidence/'repository'),'password_file':str(password)}
    host.write(state['runtime']/'backup-config.json',config)
    containers=host.compose(state,'ps','-q',capture_output=True,text=True).stdout.splitlines()
    inspected=json.loads(host.run(['docker','inspect',*containers],capture_output=True,text=True).stdout)
    for container in inspected:
        configured=container['HostConfig']
        assert configured['CapDrop']==['ALL']
        assert 'no-new-privileges:true' in configured['SecurityOpt']
        assert configured['Memory'] > 0 and configured['PidsLimit'] > 0
        assert configured['LogConfig']['Config']=={'max-size':'10m','max-file':'3'}
    measurements=[]
    media=state['runtime']/'synapse/media_store/hardening-synthetic.bin'
    media.parent.mkdir(exist_ok=True)
    signing=(state['runtime']/'synapse/server.signing.key').read_bytes()
    for size in [0,256*1024**2]:
        with media.open('wb') as stream:
            block=bytes(range(256))*4096
            for _ in range(size//len(block)): stream.write(block)
        started=time.monotonic()
        operations.run_backup(state)
        log=(state['runtime']/'backup-last.log').read_text()
        import re
        stopped=float(re.search(r'"stoppedWindowSeconds": ([0-9.]+)',log)[1])
        measurements.append({'mediaBytes':size,'stoppedWindowSeconds':stopped,'totalSeconds':round(time.monotonic()-started,3)})
    assert operations.health(state)['healthy']
    # Simulate a failed destination read without weakening SSH or storage controls.
    prior=json.loads((state['runtime']/'backup-health.json').read_text())
    host.write(state['runtime']/'backup-config.json',{**config,'password_file':str(evidence/'missing-password')})
    try:
        operations.run_backup(state)
        raise AssertionError('failed backup accepted')
    except subprocess.CalledProcessError:
        assert not operations.health(state)['healthy']
        assert json.loads((state['runtime']/'backup-health.json').read_text())['snapshotStarted']==prior['snapshotStarted']
    host.write(state['runtime']/'backup-config.json',config)
    operations.run_backup(state)
    standby=evidence/'standby'
    host.compose(state,'stop','synapse')
    try:
        host.run([sys.executable,str(host.ROOT/'recovery.py'),'restore-local','--runtime',str(state['runtime']),
                  *operations.storage_args(config),'--destination',str(standby),'--port',str(args.standby_port)],
                 stdout=subprocess.DEVNULL)
        restored=operations.load(standby)
        assert (standby/'synapse/server.signing.key').read_bytes()==signing
        def digest(path):
            with path.open('rb') as stream: return hashlib.file_digest(stream,'sha256').hexdigest()
        assert digest(standby/'synapse/media_store/hardening-synthetic.bin')==digest(media)
        account=json.loads((state['runtime']/'fictional-credentials.json').read_text())[0]
        token=host.login(restored,account['username'],account['password'])
        assert host.request(restored,'/_matrix/client/v3/logout',{},token)[0]==200
    finally:
        if (standby/'state.json').exists():
            host.compose(operations.load(standby),'down','--volumes')
        host.compose(state,'start','synapse'); host.ready(state)
    # Separate synthetic repository: never prune the recovered primary snapshots.
    retention_repo=evidence/'retention-repository'
    storage=argparse.Namespace(repository=retention_repo,password_file=password,sftp_host=None,sftp_user=None,sftp_path=None,sftp_port=22,ssh_directory=None)
    recovery.validate_storage(storage)
    stage=evidence/'retention-stage';stage.mkdir();(stage/'payload').mkdir()
    (stage/'payload/synthetic').write_text('disposable retention fixture')
    def restic(*command):
        return host.run(recovery.restic_command(storage,stage,*command),capture_output=True,text=True).stdout
    restic('init')
    tag='cbf-project-'+state['project']
    for day in range(1,11):
        restic('backup','/stage/payload','--tag',tag,'--time',f'2025-01-{day:02} 12:00:00')
    restic('backup','/stage/payload','--tag',tag)
    retention_config={**config,'repository':str(retention_repo)}
    host.write(state['runtime']/'backup-config.json',retention_config)
    # This fixture explicitly qualifies the disposable repository's actual data.
    restic('check','--read-data')
    host.write(state['runtime']/'backup-health.json',{'status':'verified','snapshotStarted':time.time(),'configSha256':operations.config_digest(retention_config)})
    before=len(json.loads(restic('snapshots','--json')))
    preview=operations.retention(state,keep_daily=7)
    assert preview['snapshotsToRemove'] > 0
    assert len(json.loads(restic('snapshots','--json')))==before
    result=operations.retention(state,keep_daily=7,apply=True)
    after=len(json.loads(restic('snapshots','--json')))
    assert after==before-result['snapshotsRemoved'] and after>=2
    restic('check','--read-data')
    host.write(state['runtime']/'backup-config.json',config)
    operations.run_backup(state)
    report={'passed':True,'backupMeasurements':measurements,'retentionBefore':before,'retentionAfter':after,
            'limits':'Disposable ARM64 Docker; no systemd/remote SFTP or production capacity qualification'}
    host.write(evidence/'result.json',report)
    print(json.dumps(report,indent=2))

if __name__=='__main__': main()
