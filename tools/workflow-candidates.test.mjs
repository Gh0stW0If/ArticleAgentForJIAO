import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCandidates } from './lib/workflow-candidates.mjs';
test('duplicate names merge generic instrument descriptions but preserve distinct explicit scales',()=>{
  const make=(id,name,instrument,domain='')=>({id,name,instrument,domain,evidence:[],reportedTimes:[]});
  const input=[make('2','VMS frequency','Daily diaries'),make('1','VMS frequency','Daily Diary of Hot Flashes (DDHF)'),
    make('3','Pain','VAS'),make('4','Pain','NRS')];
  const merged=mergeCandidates(input);
  assert.equal(merged.length,3);
  assert.equal(merged[0].id,'1');
  assert.deepEqual(mergeCandidates([...input].reverse()),merged);
});
