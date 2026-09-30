// Reproductions from the external review of ca1c539. Each one failed against
// that commit and passes here; they are kept separate from the main suite so
// the cases an outside reviewer found stay identifiable as such.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {triage, replay} from './e2e-triage.mjs';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function fixture({bothFail=false, fullTitles=true, judgeEnabled=false}={}) {
  const id={repository:'o/r', commit_sha:'abc', name:'desktop-pr', gh_run_id:'12', gh_run_attempt:'1', gh_pr_number:5, branch:'pr-5'};
  const file='specs/a.spec.ts';
  const suites=['A','B'].map(s=>({id:'suite-'+s, title:'Suite '+s, file_path:file, report_name:'r1'}));
  const cases=['A','B'].map((s,i)=>({suite_id:'suite-'+s, title:'same leaf',
    ...(fullTitles?{full_title:'Suite '+s+' > same leaf'}:{}),
    status:s==='A'||bothFail?'failed':'passed', retry_count:0, ordinal:i, error_message:'Error: expected visible'}));
  const history=['A','B'].flatMap(s=>Array.from({length:8},(_,i)=>({
    file, title:'same leaf', suite_title:'Suite '+s, report_name:'r1',
    ...(fullTitles?{full_title:'Suite '+s+' > same leaf'}:{}),
    group_id:'old-'+s+i, name:'desktop-master', branch:'master', gh_pr_number:null,
    status:s==='A'?'passed':'failed', retry_count:0, ordinal:0, commit_sha:'old'+i,
    created_at:'2026-09-'+String(20-i).padStart(2,'0')+'T00:00:00Z'
  })));
  if(judgeEnabled) history.push({...history[8],group_id:'other-pr',name:'desktop-pr',branch:'pr-6',gh_pr_number:6});
  let asked=0;
  const fetchImpl=async(url,init={})=>{
    const u=new URL(url), p=u.pathname;
    if(p==='/api/v1/reports') return Response.json({reports:[{id:'current',repository:id.repository,commit:id.commit_sha,name:id.name,gh_run_id:id.gh_run_id,gh_run_attempt:id.gh_run_attempt,status:'completed'}]});
    if(p.endsWith('/suites')) return Response.json({suites});
    if(p.endsWith('/cases')) return Response.json(cases);
    if(p.endsWith('/history')) return Response.json({observations:history,has_more:false});
    if(p.endsWith('/pulls/5/files')) return Response.json([{filename:'app/change.ts',patch:'@@ unrelated change'}]);
    if(p.endsWith('/pulls/5')) return Response.json({title:'Product fix',base:{ref:'master'}});
    if(p.endsWith('/issues/5/comments')) return Response.json(init.method==='POST'?{id:1}:[]);
    if(u.hostname==='api.anthropic.com') {
      asked++;
      return Response.json({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({
        cause:'flaky_environment',confidence:0.95,cited_evidence:['cross_pr'],explanation:'Recurs on another PR'
      })}]});
    }
    throw new Error('Unexpected fake route: '+p);
  };
  return {fetchImpl,asked:()=>asked,env:{
    COMPOSITE_IDENTITY:JSON.stringify(id),STATUS_CONTEXT:'e2e/windows',REPORT_NAME:'r1',TEST_ROOT:'.',
    MODE:'report-only',TSIO_BASE_URL:'http://fixture',GITHUB_TOKEN:'fake-only',
    ANTHROPIC_API_KEY:judgeEnabled?'fake-only':''
  }};
}

test('both failing sibling tests keep independent full-title history',async()=>{
  const f=fixture({bothFail:true});
  const r=await triage({env:f.env,fetchImpl:f.fetchImpl,log:()=>{}});
  console.log('BOTH_FAIL',JSON.stringify({verdict:r.verdict,findings:r.findings.map(x=>({
    full_title:x.full_title,class:x.class,blocking:x.blocking,trunk:x.trunk
  }))}));
  assert.equal(r.findings.find(x=>x.full_title==='Suite A > same leaf').blocking,true,
    'Suite A passed on trunk and must not borrow Suite B failures');
});

test('unresolved test identity cannot reach or be cleared by the judge',async()=>{
  const f=fixture({fullTitles:false,judgeEnabled:true});
  const r=await triage({env:f.env,fetchImpl:f.fetchImpl,log:()=>{}});
  console.log('UNRESOLVED_JUDGE',JSON.stringify({verdict:r.verdict,asked:f.asked(),findings:r.findings.map(x=>({
    class:x.class,identity_unresolved:x.identity_unresolved,blocking:x.blocking,decision:x.decision
  }))}));
  assert.equal(f.asked(),0,'Judge must not receive unresolved identity evidence');
  assert.equal(r.verdict,'FAILURE');
});

test('replay retains complete run identity from its input corpus',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'triage-replay-fixture-'));
  const logs=[];
  try {
    const runsPath=join(dir,'runs.json');
    writeFileSync(runsPath,JSON.stringify([{
      repository:'o/r',commit_sha:'abc',name:'desktop-pr',branch:'pr-5',
      pr:5,gh_run_id:'12',gh_run_attempt:'1',truth:'regression',run_at:'2026-09-30T00:00:00Z'
    }]));
    const f=fixture();
    const result=await replay({runsPath,base:'http://fixture',env:{},fetchImpl:f.fetchImpl,log:s=>logs.push(s)});
    console.log('REPLAY_IDENTITY',JSON.stringify({processed:result.length,logs}));
    assert.equal(result.length,1,'A complete corpus entry must be evaluated, not silently skipped');
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});
