"""Synthetic behavioral regressions for the bounded host operations changes."""
import argparse
import json
import os
import pathlib
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
import host
import recovery
import operations


class Hardening(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='cbf-hardening-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.runtime = self.root/'runtime'; self.runtime.mkdir()
        self.source = self.runtime/'synapse'; self.source.mkdir()
        self.stage = self.root/'stage'; self.stage.mkdir()
        self.state = {'runtime':self.runtime,'project':'cbf-e2ee-0123456789'}

    def test_precopy_reconciles_deleted_new_replaced_and_same_size_restored_mtime(self):
        for name in ['unchanged','deleted','rewritten','replaced','server.signing.key']:
            (self.source/name).write_bytes(b'old!')
        copied = []
        stopped = False
        original_copy = recovery.shutil.copy2
        def copy(source, target):
            if stopped: copied.append(pathlib.Path(source).name)
            return original_copy(source,target)
        def compose(state,*args,**kwargs):
            nonlocal stopped
            if args[0] == 'ps': return subprocess.CompletedProcess([],0,stdout='synapse\n')
            if args == ('stop','synapse'):
                stopped = True
                (self.source/'deleted').unlink()
                rewritten = self.source/'rewritten'; before = rewritten.stat()
                rewritten.write_bytes(b'new!')
                os.utime(rewritten,ns=(before.st_atime_ns,before.st_mtime_ns))
                (self.source/'replaced').unlink(); (self.source/'replaced').write_bytes(b'new!')
                (self.source/'new').write_bytes(b'new!')
            if 'pg_dump' in args:
                target = self.stage/'payload/synapse'
                self.assertFalse((target/'deleted').exists())
                for name in ['rewritten','replaced','new']: self.assertEqual((target/name).read_bytes(),b'new!')
                self.assertEqual((target/'server.signing.key').read_bytes(),b'old!')
                kwargs['stdout'].write(b'synthetic-consistent-dump')
            return subprocess.CompletedProcess([],0)
        with patch.object(recovery,'compose',side_effect=compose), patch.object(recovery,'ready'), patch.object(recovery.shutil,'copy2',side_effect=copy):
            recovery.capture_snapshot(self.state,self.stage)
        self.assertEqual(set(copied),{'rewritten','replaced','new'})
        self.assertEqual((self.stage/'payload/database.dump').read_bytes(),b'synthetic-consistent-dump')

    def test_live_copy_deletion_is_reconciled_and_stopped_mutation_fails(self):
        file = self.source/'racing'; file.write_bytes(b'old')
        original = recovery.shutil.copy2
        def remove(source,target):
            original(source,target); pathlib.Path(source).unlink()
        with patch.object(recovery.shutil,'copy2',side_effect=remove):
            prior = recovery.stage_synapse(self.source,self.stage)
        recovery.stage_synapse(self.source,self.stage,prior)
        self.assertFalse((self.stage/'racing').exists())
        file.write_bytes(b'old')
        def modify(source,target):
            original(source,target); pathlib.Path(source).write_bytes(b'new')
        with patch.object(recovery.shutil,'copy2',side_effect=modify):
            with self.assertRaisesRegex(RuntimeError,'changed while stopped'):
                recovery.stage_synapse(self.source,self.stage,{})

    def test_symlink_is_refused(self):
        (self.source/'outside').symlink_to(self.root/'secret')
        with self.assertRaisesRegex(RuntimeError,'regular files'):
            recovery.stage_synapse(self.source,self.stage)

    def test_budget_fails_before_stop_and_uses_runtime_disk(self):
        (self.source/'media').write_bytes(b'x')
        args = argparse.Namespace(runtime=self.runtime, staging_directory=None, action='backup',maximum_staging_bytes=1)
        with patch.object(recovery,'compose',return_value=subprocess.CompletedProcess([],0,stdout='1024\n')) as compose:
            with self.assertRaisesRegex(RuntimeError,'Insufficient staging'):
                recovery.prepare_staging(args,self.state)
        self.assertEqual(compose.call_args.args[1],'exec')
        self.assertTrue((self.runtime/'.backup-staging').is_dir())

    def test_health_timer_persists_stale_and_failure_locally(self):
        config = {'repository':'/fixture/repo'}
        host.write(self.runtime/'backup-config.json',config)
        host.write(self.runtime/'backup-health.json',{'status':'verified','snapshotStarted':time.time()-100000,'configSha256':operations.config_digest(config)})
        self.assertEqual(operations.health(self.state)['attention'],'stale')
        saved = json.loads((self.runtime/'backup-status.json').read_text())
        self.assertFalse(saved['healthy'])
        name = operations.schedule(self.state)
        self.assertTrue((self.runtime/(name+'-health.timer')).exists())
        self.assertIn('backup-health',(self.runtime/(name+'-health.service')).read_text())
        (self.runtime/'backup-config.json').write_text('broken json')
        self.assertFalse(operations.health(self.state)['healthy'])

    def test_expiry_is_bounded_and_api_is_one_use(self):
        host.write(self.runtime/'admin.json',{'username':'admin','password':'synthetic'})
        with patch.object(host,'request',return_value=(200,{'token':'synthetic'})) as request:
            host.invite(self.state,expiry=48*3600,admin_token='synthetic')
            body=request.call_args.args[2]
            self.assertEqual(body['uses_allowed'],1)
            self.assertAlmostEqual(body['expiry_time']/1000,time.time()+48*3600,delta=1)
            for invalid in [0,7*86400+1]:
                with self.assertRaises(ValueError): host.invite(self.state,invalid,admin_token='synthetic')

    def test_retention_requires_preview_fresh_backup_and_protects_newest(self):
        config={'repository':str(self.root/'repo'),'password_file':str(self.root/'password')}
        host.write(pathlib.Path(config['password_file']),'synthetic')
        host.write(self.runtime/'backup-config.json',config)
        now=time.time()
        host.write(self.runtime/'backup-health.json',{'status':'verified','snapshotStarted':now,'configSha256':operations.config_digest(config)})
        stamp=operations.datetime.datetime.now(operations.datetime.timezone.utc).isoformat()
        old='a'*64; new='b'*64
        snapshots=[{'id':old,'time':stamp},{'id':new,'time':stamp+'0'}]
        # Use valid distinct timestamps.
        snapshots[0]['time']='2025-01-01T00:00:00Z'
        snapshots[1]['time']=stamp
        calls=[]
        def run(cmd,**kwargs):
            calls.append(cmd)
            if 'snapshots' in cmd: output=snapshots
            elif '--dry-run' in cmd: output=[{'remove':[{'id':old}]}]
            else: output={}
            return subprocess.CompletedProcess(cmd,0,stdout=json.dumps(output))
        with patch.object(operations.subprocess,'run',side_effect=run):
            with self.assertRaisesRegex(RuntimeError,'dry-run inspection'):
                operations.retention(self.state,apply=True)
            result=operations.retention(self.state)
            self.assertEqual(result['snapshotsToRemove'],1)
            self.assertFalse(any('prune' in cmd for cmd in calls))
            operations.retention(self.state,apply=True)
            forget=[cmd for cmd in calls if 'forget' in cmd and '--dry-run' not in cmd]
            self.assertEqual(forget[0][-2:],['forget',old])
            self.assertTrue(any('prune' in cmd for cmd in calls))
        host.write(self.runtime/'backup-health.json',{'status':'failed'})
        with patch.object(operations.subprocess,'run') as run:
            with self.assertRaisesRegex(RuntimeError,'recent verified'):
                operations.retention(self.state)
            run.assert_not_called()

if __name__ == '__main__': unittest.main()
