import argparse
import json
import host
import pathlib
import subprocess
import sys
import os
import signal
import select
import tempfile
import unittest
from unittest.mock import patch
import recovery


class RecoveryGuards(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='cbf-recovery-unit-')
        self.root=pathlib.Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        password=self.root/'password';password.write_text('synthetic-test-only');password.chmod(0o600)
        ssh=self.root/'ssh';ssh.mkdir(mode=0o700)
        for name in ['id_ed25519','known_hosts']:
            (ssh/name).write_text('synthetic-validation-only');(ssh/name).chmod(0o600)
        self.args=argparse.Namespace(repository=None,password_file=password,sftp_host='backup.example',sftp_user='backup',sftp_path='/backups/circle',sftp_port=22,ssh_directory=ssh)

    def test_actual_process_lock_contention_before_service_mutation(self):
        runtime=self.root/'managed';runtime.mkdir()
        host.write(runtime/'state.json',{'project':'cbf-e2ee-0123456789','mode':'local'})
        command=[sys.executable,str(pathlib.Path(recovery.__file__)),'backup','--runtime',str(runtime),'--repository',str(self.root/'repo'),'--password-file',str(self.args.password_file)]
        with recovery.operation_lock(runtime):
            result=subprocess.run(command,capture_output=True,text=True,timeout=10)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('Another recovery operation holds this runtime lock',result.stderr)
        self.assertEqual((runtime/'.recovery-operation.lock').stat().st_mode & 0o777,0o600)
        with recovery.operation_lock(runtime): pass

    def test_sigterm_runs_actual_process_finally_cleanup(self):
        script = r"""
import pathlib, subprocess, sys, time
import recovery
root=pathlib.Path(sys.argv[1]); stage=root/'signal-stage';stage.mkdir()
def compose(state,*args,**kwargs):
    if args[0]=='ps': return subprocess.CompletedProcess([],0,stdout='synapse\n')
    if 'pg_dump' in args:
        print('DUMP_STARTED',flush=True)
        time.sleep(30)
    if args==('start','synapse'): (root/'resumed').write_text('yes')
    return subprocess.CompletedProcess([],0)
recovery.compose=compose
recovery.ready=lambda state: (root/'ready').write_text('yes')
with recovery.termination_cleanup(), recovery.operation_lock(root):
    recovery.capture_snapshot({'runtime':root/'empty'},stage)
"""
        (self.root/'empty').mkdir()
        env={**os.environ,'PYTHONPATH':str(pathlib.Path(recovery.__file__).parent)}
        child=subprocess.Popen([sys.executable,'-c',script,str(self.root)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
        try:
            self.assertTrue(select.select([child.stdout],[],[],10)[0],'child did not reach capture')
            self.assertEqual(child.stdout.readline().strip(),'DUMP_STARTED')
            child.send_signal(signal.SIGTERM)
            _,stderr=child.communicate(timeout=10)
            self.assertEqual(child.returncode,143,stderr)
            self.assertTrue((self.root/'resumed').exists())
            self.assertTrue((self.root/'ready').exists())
            with recovery.operation_lock(self.root): pass
        finally:
            if child.poll() is None: child.kill();child.wait()

    def test_generated_production_restart_policy(self):
        args=argparse.Namespace(runtime=self.root/'production',imported_images=False,mode='production',server_name='circle.example',public_url='https://matrix.circle.example',port=0)
        with patch.object(host,'compose',side_effect=RuntimeError('stop before starting containers')):
            with self.assertRaisesRegex(RuntimeError,'stop before starting containers'):
                host.initialize(args)
        spec=json.loads((args.runtime/'compose.json').read_text())
        self.assertEqual({s['restart'] for s in spec['services'].values()},{'unless-stopped'})

    def test_rate_profile_local_only_and_default_unchanged(self):
        def args(name,mode,test):
            return argparse.Namespace(runtime=self.root/name,imported_images=False,mode=mode,test_rate_profile=test,server_name='circle.example',public_url='https://matrix.circle.example',port=0)
        production=args('refused','production',True)
        with self.assertRaisesRegex(RuntimeError,'restricted to disposable local'):
            host.initialize(production)
        self.assertFalse(production.runtime.exists())
        for name,enabled in [('default',False),('automation',True)]:
            config_args=args(name,'local',enabled)
            with patch.object(host,'compose',side_effect=RuntimeError('stop before starting containers')):
                with self.assertRaisesRegex(RuntimeError,'stop before starting containers'):
                    host.initialize(config_args)
            config=json.loads((config_args.runtime/'synapse/homeserver.yaml').read_text())
            state=json.loads((config_args.runtime/'state.json').read_text())
            self.assertEqual(state['testRateProfile'],enabled)
            self.assertEqual('rc_login' in config,enabled)
            if enabled:
                self.assertEqual(config['rc_login']['account']['burst_count'],200)
                self.assertNotIn('failed_attempts',config['rc_login'])

    def test_sftp_strict_isolation(self):
        recovery.validate_storage(self.args)
        cmd=recovery.restic_command(self.args,self.root,'backup','/stage/payload')
        self.assertIn(str(self.args.ssh_directory)+':/ssh:ro',cmd)
        self.assertIn('bridge',cmd)
        ssh=recovery.ssh_command(self.args)
        for option in ['StrictHostKeyChecking=yes','IdentityAgent=none','ForwardAgent=no','ClearAllForwardings=yes','IdentitiesOnly=yes','PasswordAuthentication=no','KbdInteractiveAuthentication=no']:
            self.assertIn(option,ssh)
        self.assertEqual(ssh[1:3],['-F','/dev/null'])

    def test_untrusted_ssh_config_and_symlink_rejected(self):
        extra=self.args.ssh_directory/'config';extra.write_text('ProxyCommand anything')
        with self.assertRaises(RuntimeError): recovery.validate_storage(self.args)
        extra.unlink();key=self.args.ssh_directory/'id_ed25519';key.unlink();key.symlink_to(self.args.password_file)
        with self.assertRaises(RuntimeError): recovery.validate_storage(self.args)

    def test_injection_and_traversal_rejected(self):
        for field,value in [('sftp_host','-oProxyCommand=x'),('sftp_user','a b'),('sftp_path','/a/../b')]:
            old=getattr(self.args,field);setattr(self.args,field,value)
            with self.assertRaises(RuntimeError): recovery.validate_storage(self.args)
            setattr(self.args,field,old)

    def capture_failure(self,running,leave_stopped=False):
        calls=[]
        def compose(_state,*args,**kwargs):
            calls.append(args)
            if args[0]=='ps': return subprocess.CompletedProcess([],0,stdout='synapse\n' if running else '')
            if 'pg_dump' in args: raise RuntimeError('injected dump failure')
            return subprocess.CompletedProcess([],0)
        stage=self.root/'stage';stage.mkdir()
        with patch.object(recovery,'compose',side_effect=compose), patch.object(recovery,'ready') as ready:
            with self.assertRaisesRegex(RuntimeError,'injected dump failure'):
                recovery.capture_snapshot({'runtime':self.root},stage,leave_stopped)
            self.assertEqual(ready.called,running and not leave_stopped)
        return calls

    def test_capture_keeps_exact_decision_receipts_and_excludes_external_reason(self):
        runtime=self.root/'runtime';runtime.mkdir()
        receipt=runtime/'moderation-decision-0123456789abcdef.json'
        host.write(receipt, {'status':'verified','reason':'synthetic decision'})
        host.write(runtime/'moderation-decision-unrelated.json', {'not':'a tool receipt'})
        host.write(self.root/'external-reason.txt', 'not part of runtime snapshot')
        stage=self.root/'stage';stage.mkdir()
        def compose(_state,*args,**kwargs):
            return subprocess.CompletedProcess([],0,stdout='synapse\n' if args[0]=='ps' else '')
        with patch.object(recovery,'compose',side_effect=compose), patch.object(recovery,'ready'):
            recovery.capture_snapshot({'runtime':runtime},stage)
        self.assertEqual((stage/'payload'/receipt.name).read_bytes(),receipt.read_bytes())
        self.assertFalse((stage/'payload/moderation-decision-unrelated.json').exists())
        self.assertFalse((stage/'payload/external-reason.txt').exists())

    def test_receipt_symlink_is_rejected_and_primary_resumes(self):
        runtime=self.root/'runtime';runtime.mkdir()
        external=self.root/'external-reason.txt';external.write_text('outside receipt')
        (runtime/'moderation-decision-0123456789abcdef.json').symlink_to(external)
        stage=self.root/'stage';stage.mkdir();calls=[]
        def compose(_state,*args,**kwargs):
            calls.append(args)
            return subprocess.CompletedProcess([],0,stdout='synapse\n' if args[0]=='ps' else '')
        with patch.object(recovery,'compose',side_effect=compose), patch.object(recovery,'ready'):
            with self.assertRaisesRegex(RuntimeError,'regular runtime files'):
                recovery.capture_snapshot({'runtime':runtime},stage)
        self.assertEqual(calls[-1],('start','synapse'))

    def test_failure_resumes_previously_running_primary(self):
        calls=self.capture_failure(True)
        self.assertEqual(calls[-1],('start','synapse'))

    def test_stopped_primary_stays_stopped(self):
        self.assertNotIn(('start','synapse'),self.capture_failure(False))

    def test_explicit_leave_stopped(self):
        self.assertNotIn(('start','synapse'),self.capture_failure(True,True))

if __name__=='__main__': unittest.main()
