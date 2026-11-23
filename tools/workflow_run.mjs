import { resolve } from 'node:path';
import { runWorkflowStage } from './lib/workflow-engine.mjs';

const args = process.argv.slice(2);
const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : '';
const root = resolve(process.env.AA_ROOT || process.cwd());
try {
  const state = await runWorkflowStage(root, option('--year'), option('--study'), option('--stage'), {
    fresh: args.includes('--fresh'), reuseBasics: args.includes('--reuse-basics'),
    ...(option('--selection-revision') ? { selectionRevision: Number(option('--selection-revision')) } : {}),
  });
  console.log('工作流阶段完成', option('--stage'), state.stages[option('--stage')].status);
} catch (error) {
  console.error('工作流失败', error.message);
  process.exitCode = 1;
}
