#!/usr/bin/env python3
"""Encrypted, stopped-primary backups and an isolated local standby drill."""
import contextlib, fcntl, signal
import argparse, json, os, pathlib, re, secrets, shlex, shutil, subprocess, tempfile, time
from host import compose, ready, run, write, ROOT, prepare_synapse_ownership
RESTIC='restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510'

def outside_source(path):
    resolved = path.resolve()
    if resolved == ROOT.parent or ROOT.parent in resolved.parents:
        raise RuntimeError('Recovery data must remain outside checkout')
    return resolved


@contextlib.contextmanager
def operation_lock(runtime):
    """Serialize this primary's capture/restore before any service mutation."""
    path = outside_source(runtime) / '.recovery-operation.lock'
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError('Another recovery operation holds this runtime lock') from exc
        yield
    finally:
        os.close(descriptor)
    # Never unlink: waiters must continue to contend on the same inode.


@contextlib.contextmanager
def termination_cleanup():
    """First SIGTERM unwinds finally blocks; subsequent SIGTERM cannot interrupt them."""
    previous = signal.getsignal(signal.SIGTERM)
    def terminate(signum, _frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, terminate)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)


@contextlib.contextmanager
def protect_resume():
    # A first signal arriving during resume must not interrupt its service command.
    previous = signal.getsignal(signal.SIGTERM)
    received = []
    signal.signal(signal.SIGTERM, lambda number, frame: received.append(number))
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)
    if received:
        raise SystemExit(128 + received[0])


def validate_storage(a):
    a.password_file = outside_source(a.password_file)
    if not a.password_file.is_file() or a.password_file.stat().st_mode & 0o077:
        raise RuntimeError('Provide an existing private (0600) restic password file')
    if a.repository:
        a.repository = outside_source(a.repository)
        if a.repository in a.password_file.parents:
            raise RuntimeError('Keep the backup password outside its repository')
        if a.ssh_directory or a.sftp_user or a.sftp_path:
            raise RuntimeError('SSH options require --sftp-host')
        a.repository.mkdir(mode=0o700, parents=True, exist_ok=True)
        return
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', a.sftp_host or ''):
        raise RuntimeError('SFTP host must be a DNS name or IPv4 address')
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_-]*', a.sftp_user or ''):
        raise RuntimeError('Provide a dedicated --sftp-user')
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', a.sftp_path or '') or '..' in a.sftp_path.split('/'):
        raise RuntimeError('Provide an absolute SFTP repository path without parent traversal')
    if not 1 <= a.sftp_port <= 65535 or not a.ssh_directory:
        raise RuntimeError('Provide a valid SFTP port and dedicated --ssh-directory')
    a.ssh_directory = outside_source(a.ssh_directory)
    if a.ssh_directory == (pathlib.Path.home()/'.ssh').resolve():
        raise RuntimeError('Never mount your entire ~/.ssh directory')
    if not a.ssh_directory.is_dir() or a.ssh_directory.stat().st_mode & 0o077:
        raise RuntimeError('Dedicated SSH directory must be private (0700)')
    if {f.name for f in a.ssh_directory.iterdir()} != {'id_ed25519', 'known_hosts'}:
        raise RuntimeError('Dedicated SSH directory must contain only id_ed25519 and known_hosts')
    for name in ['id_ed25519', 'known_hosts']:
        path = a.ssh_directory/name
        if path.is_symlink() or not path.is_file() or not path.stat().st_size:
            raise RuntimeError('SSH files must be nonempty regular files, not symlinks')
    if (a.ssh_directory/'id_ed25519').stat().st_mode & 0o077:
        raise RuntimeError('SSH private key must be mode 0600')


def ssh_command(a):
    return ['ssh','-F','/dev/null','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
            '-o','UserKnownHostsFile=/ssh/known_hosts','-o','GlobalKnownHostsFile=/dev/null',
            '-o','IdentityAgent=none','-o','IdentitiesOnly=yes','-o','ForwardAgent=no',
            '-o','ClearAllForwardings=yes','-o','PasswordAuthentication=no',
            '-o','KbdInteractiveAuthentication=no','-o','ConnectTimeout=15',
            '-i','/ssh/id_ed25519','-p',str(a.sftp_port),'-l',a.sftp_user,'-s',a.sftp_host,'sftp']


def restic_command(a, stage, *args):
    command = ['docker','run','--rm','--network','none' if a.repository else 'bridge']
    if a.repository:
        command += ['-v',str(a.repository)+':/repository']
        repository = '/repository'
        options = []
    else:
        command += ['-v',str(a.ssh_directory)+':/ssh:ro']
        repository = f'sftp:{a.sftp_user}@{a.sftp_host}:{a.sftp_path}'
        options = ['-o','sftp.command='+shlex.join(ssh_command(a))]
    return command + ['-v',str(a.password_file)+':/password:ro','-v',str(stage)+':/stage',
                      '-e','RESTIC_PASSWORD_FILE=/password',RESTIC,'-r',repository,*options,*args]


def capture_snapshot(state, stage, leave_stopped=False):
    was_running = 'synapse' in compose(state,'ps','--status','running','--services',capture_output=True,text=True).stdout.splitlines()
    try:
        compose(state,'stop','synapse')
        (stage/'payload').mkdir()
        for name in ['synapse','state.json','compose.json','postgres-password','client-config.json','admin.json','fictional-credentials.json','Caddyfile','hosting.json']:
            source=state['runtime']/name; target=stage/'payload'/name
            if source.is_dir(): shutil.copytree(source,target)
            elif source.exists(): shutil.copy2(source,target)
        # Preserve the local decision audit alongside the database suspension state.
        # Only this tool's receipt filenames belong in the encrypted snapshot;
        # never follow a receipt symlink or read an external reason-file path.
        for source in state['runtime'].glob('moderation-decision-*.json'):
            if not re.fullmatch(r'moderation-decision-[a-f0-9]{16}\.json', source.name):
                continue
            if source.is_symlink() or not source.is_file():
                raise RuntimeError('Moderation receipts must be regular runtime files')
            shutil.copy2(source, stage/'payload'/source.name)
        with (stage/'payload/database.dump').open('wb') as out:
            compose(state,'exec','-T','postgres','pg_dump','-U','synapse','-d','synapse','-Fc','--exclude-table-data=e2e_one_time_keys_json',stdout=out)
    finally:
        if was_running and not leave_stopped:
            with protect_resume():
                compose(state,'start','synapse')
                ready(state)
    return was_running


def main():
    os.umask(0o077)
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['backup','restore-local','init-repository'])
    p.add_argument('--runtime',type=pathlib.Path,required=True)
    storage=p.add_mutually_exclusive_group(required=True)
    storage.add_argument('--repository',type=pathlib.Path)
    storage.add_argument('--sftp-host')
    p.add_argument('--sftp-user'); p.add_argument('--sftp-path')
    p.add_argument('--sftp-port',type=int,default=22)
    p.add_argument('--ssh-directory',type=pathlib.Path)
    p.add_argument('--leave-stopped',action='store_true',help='Explicitly keep the primary stopped for a restore drill')
    p.add_argument('--password-file',type=pathlib.Path,required=True)
    p.add_argument('--destination',type=pathlib.Path)
    p.add_argument('--port',type=int,default=18009)
    p.add_argument('--snapshot',default='latest')
    a=p.parse_args(); start=time.monotonic()
    a.runtime=outside_source(a.runtime)
    validate_storage(a)
    state=json.loads((a.runtime/'state.json').read_text());state['runtime']=a.runtime
    if not re.fullmatch(r'cbf-e2ee-[a-f0-9]{10}',state['project']): raise RuntimeError('Not a managed project')
    with termination_cleanup(), operation_lock(a.runtime), tempfile.TemporaryDirectory(prefix='cbf-encrypted-recovery-') as tmp:
        stage=pathlib.Path(tmp)
        def restic(*args):
            run(restic_command(a,stage,*args))
        if a.action=='init-repository':
            restic('init')
        elif a.action=='backup':
            was_running=capture_snapshot(state,stage,a.leave_stopped)
            # The primary is already resumed before any potentially slow remote operation.
            if a.repository and not (a.repository/'config').exists(): restic('init')
            restic('backup','/stage/payload','--tag','cbf-encrypted-host')
            restic('check','--read-data')
            print('Encrypted backup verified. Primary '+('resumed before upload.' if was_running and not a.leave_stopped else 'remains stopped.'))
        else:
            if state['mode']!='local': raise RuntimeError('This automatic restore drill is local-only; production fencing is an operator procedure')
            running=compose(state,'ps','--status','running','--services',capture_output=True,text=True).stdout.splitlines()
            if 'synapse' in running: raise RuntimeError('Stop the primary before restoring; two writers are forbidden')
            if not a.destination: raise RuntimeError('--destination required')
            dest=a.destination.resolve()
            if dest.exists() or dest==ROOT.parent or ROOT.parent in dest.parents: raise RuntimeError('Destination must be new and outside checkout')
            restic('restore',a.snapshot,'--target','/stage/restore')
            payload=stage/'restore/stage/payload'
            restored=json.loads((payload/'state.json').read_text())
            if restored['project']!=state['project']: raise RuntimeError('Snapshot belongs to another primary')
            dest.mkdir(mode=0o700,parents=True)
            with operation_lock(dest):
                shutil.copytree(payload,dest,dirs_exist_ok=True)
                restored.update(runtime=dest,project='cbf-e2ee-'+secrets.token_hex(5),url=f'http://127.0.0.1:{a.port}')
                spec=json.loads((dest/'compose.json').read_text())
                spec['services']['postgres']['healthcheck']['test']=['CMD-SHELL','pg_isready -h 127.0.0.1 -U synapse -d synapse']
                spec['services']['synapse']['ports']=[f'127.0.0.1:{a.port}:8008']
                spec['services']['synapse']['volumes']=[str(dest/'synapse')+':/data']
                spec['secrets']['postgres-password']['file']=str(dest/'postgres-password')
                write(dest/'compose.json',spec);write(dest/'state.json',{**restored,'runtime':str(dest)})
                client=json.loads((dest/'client-config.json').read_text());client['homeserverUrl']=restored['url'];write(dest/'client-config.json',client)
                config=json.loads((dest/'synapse/homeserver.yaml').read_text());config['public_baseurl']=restored['url']+'/';write(dest/'synapse/homeserver.yaml',config)
                compose(restored,'up','-d','--wait','postgres')
                with (dest/'database.dump').open('rb') as inp:
                    compose(restored,'exec','-T','postgres','pg_restore','-U','synapse','-d','synapse','--exit-on-error',stdin=inp)
                compose(restored,'exec','-T','postgres','psql','-U','synapse','-d','synapse','-c','TRUNCATE e2e_one_time_keys_json;')
                prepare_synapse_ownership(dest, spec)
                compose(restored,'up','-d','synapse');ready(restored)
                (dest/'database.dump').unlink()
            print('Standby restored in same-machine simulated failure domain. Primary remains stopped.')
        print('Elapsed seconds:',round(time.monotonic()-start,2))

if __name__=='__main__': main()
