import importlib.util
from pathlib import Path
import unittest

path=Path(__file__).resolve().parents[1]/'tools'/'nightshift_codex_dispatcher.py'
spec=importlib.util.spec_from_file_location('nightshift_dispatcher',path)
d=importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
SHA='a'*40
RUN={'id':42,'name':'Tests','conclusion':'failure','head_sha':SHA,'repository':{'full_name':d.REPO},'pull_requests':[{'number':647}]}
PR={'number':647,'state':'open','user':{'login':'ruslanjurakulov'},'head':{'sha':SHA,'repo':{'full_name':d.REPO}}}
class DispatcherTests(unittest.TestCase):
    def event(self,**kw):return {'action':'completed','workflow_run':{**RUN,**kw}}
    def test_happy(self):self.assertEqual(d.decide(self.event(),PR,[])[1],'ready')
    def test_stale_sha(self):self.assertEqual(d.decide(self.event(head_sha='b'*40),PR,[])[1],'stale_workflow_run')
    def test_fork(self):self.assertEqual(d.decide(self.event(),{**PR,'head':{**PR['head'],'repo':{'full_name':'other/repo'}}},[])[1],'fork_not_allowed')
    def test_owner(self):self.assertEqual(d.decide(self.event(),{**PR,'user':{'login':'other'}},[])[1],'author_not_owner')
    def test_success(self):self.assertEqual(d.decide(self.event(conclusion='success'),PR,[])[1],'not_a_failed_completed_run')
    def test_unlinked(self):self.assertEqual(d.decide(self.event(pull_requests=[]),PR,[])[1],'run_not_linked_to_pr')
    def test_duplicate(self):
        marker='<!-- nightshift-codex-dispatch:'+SHA+':42 -->'
        self.assertEqual(d.decide(self.event(),PR,[{'body':marker}])[1],'already_dispatched')
    def test_budget(self):
        c=[{'body':'<!-- nightshift-codex-dispatch:1 -->'},{'body':'<!-- nightshift-codex-dispatch:2 -->'}]
        self.assertEqual(d.decide(self.event(),PR,c)[1],'dispatch_budget_exhausted')
if __name__=='__main__':unittest.main()
