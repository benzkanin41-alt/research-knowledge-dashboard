import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
try:
    from . import export_snapshot as export
    from . import validate_snapshot as validation
except ImportError:
    import export_snapshot as export
    import validate_snapshot as validation


class SnapshotContracts(unittest.TestCase):
    def test_unverified_multi_company_excerpt_cannot_be_published_as_rationale(self):
        bad={'metric_groups':[{'covered_without_number':[{'reason':'Buy DELTA. Banks KTB KBANK earnings 53300'}]}]}
        self.assertFalse(validation.coverage_notes_are_safe(bad))
        bad['metric_groups'][0]['covered_without_number'][0]['reason']='ยังไม่มีตัวเลขประมาณการของงวดและหัวข้อนี้ที่ผ่านการยืนยันจากสำนักนี้ โปรดดูรายงานต้นทาง'
        self.assertTrue(validation.coverage_notes_are_safe(bad))
    def test_import_success_cannot_bypass_failed_outer_quality_gate(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            with self.assertRaises(RuntimeError):export.assert_release_validation(root,{'id':1})
            (root/'qa_release_validation.json').write_text(json.dumps({'status':'failed','latest_import_id':1}),encoding='utf-8')
            with self.assertRaises(RuntimeError):export.assert_release_validation(root,{'id':1})
    def test_full_release_proof_rejects_subsequent_code_or_database_change(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'app.py').write_text('safe');(root/'db.sqlite').write_bytes(b'test')
            proof={'status':'success','latest_import_id':1,'quality':{'regressions':{'status':'passed'},'canonical_code_unchanged':True},'primary_actual_provenance_audit_v68':{'failure_count':0},'verified_code_hashes':{'app.py':export.sha256_file(root/'app.py')},'verified_database_files':{'db.sqlite':{'size':4,'sha256':export.sha256_file(root/'db.sqlite')}}}
            (root/'qa_release_validation.json').write_text(json.dumps(proof),encoding='utf-8')
            self.assertEqual(export.assert_release_validation(root,{'id':1})['status'],'passed')
            (root/'db.sqlite-wal').write_bytes(b'new transaction')
            with self.assertRaises(RuntimeError):export.assert_release_validation(root,{'id':1})
            (root/'db.sqlite-wal').unlink()
            with self.assertRaises(RuntimeError):export.assert_release_validation(root,{'id':2})
            (root/'db.sqlite').write_bytes(b'edit')
            with self.assertRaises(RuntimeError):export.assert_release_validation(root,{'id':1})
            (root/'db.sqlite').write_bytes(b'test');(root/'app.py').write_text('changed')
            with self.assertRaises(RuntimeError):export.assert_release_validation(root,{'id':1})
    def test_privacy_sanitizer_preserves_public_numbers_and_citation(self):
        raw={'stock':{'id':1,'symbol':'EXAMPLE'},'metrics':[{'estimate':758.0,'actual':757.0,'delta':-1.0,'source_name':'company-report.pdf','source_line':14,'source_path':r'D:\private\company-report.pdf'}],'database_path':r'E:\private\research.sqlite','reason':r'Source C:\private\research.md'}
        clean=export.sanitize_payload(raw)
        self.assertEqual(list(export.public_numeric_coordinates(raw)),list(export.public_numeric_coordinates(clean)))
        self.assertEqual(clean['metrics'][0]['source_name'],'company-report.pdf')
        self.assertNotIn('source_path',clean['metrics'][0])
        self.assertNotIn('database_path',clean)
        self.assertEqual(clean['reason'],'Source [local path hidden]')

    def test_decode_json_before_path_scan(self):
        good={'text':'\\u0016*\\'}
        for _where,value in validation.walk_json(json.loads(json.dumps(good))):
            if isinstance(value,str):self.assertIsNone(validation.UNC_PATH_RE.search(value))
        self.assertIsNotNone(validation.UNC_PATH_RE.search(r'\\server\private\file'))
        self.assertIsNotNone(validation.WINDOWS_PATH_RE.search(r'D:\private\file'))

    def test_snapshot_requires_latest_success_and_no_running_import(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'fixture.sqlite'
            db=sqlite3.connect(path)
            db.execute('CREATE TABLE import_runs(id INTEGER,started_at TEXT,status TEXT)')
            db.execute("INSERT INTO import_runs VALUES(1,'2026-09-17','failed')");db.commit()
            with self.assertRaises(RuntimeError):export.assert_idle_database(path)
            db.execute("UPDATE import_runs SET status='success'");db.commit()
            self.assertEqual(export.assert_idle_database(path)['id'],1)
            db.execute("INSERT INTO import_runs VALUES(2,'2026-09-17','running')");db.commit()
            with self.assertRaises(RuntimeError):export.assert_idle_database(path)
            db.close()

    def test_public_metric_change_is_detected(self):
        self.assertNotEqual(list(export.public_numeric_coordinates({'estimate':758})),list(export.public_numeric_coordinates({'estimate':757})))

if __name__=='__main__':unittest.main()
