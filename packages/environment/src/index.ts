import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);

export interface PreparationStep {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
}
export interface PreparationResult {
  readonly stepId: string;
  readonly status: "passed" | "failed";
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly retryable: boolean;
}
export async function runPreparationStep(step: PreparationStep): Promise<PreparationResult> {
  if (!step.id.trim() || !step.executable.trim()) throw new Error("환경 준비 단계 ID와 실행 파일이 필요합니다.");
  try {
    const result = await execute(step.executable,[...step.args],{
      cwd:step.cwd,encoding:"utf8",timeout:step.timeoutMs ?? 120_000,
      maxBuffer:16*1024*1024,windowsHide:true
    });
    return {stepId:step.id,status:"passed",stdout:result.stdout,stderr:result.stderr,retryable:false};
  } catch (error) {
    const failure=error as NodeJS.ErrnoException & {stdout?:string;stderr?:string;code?:string|number};
    return {
      stepId:step.id,status:"failed",
      ...(typeof failure.code==="number"?{exitCode:failure.code}:{}),
      stdout:failure.stdout ?? "",stderr:failure.stderr ?? String(failure.message),
      retryable:true
    };
  }
}
export async function runPreparationPlan(steps: readonly PreparationStep[]): Promise<{results:PreparationResult[];completed:boolean}> {
  const results:PreparationResult[]=[];
  for(const step of steps){
    const result=await runPreparationStep(step);
    results.push(result);
    if(result.status==="failed") return {results,completed:false};
  }
  return {results,completed:true};
}
export async function retryPreparationStep(step:PreparationStep):Promise<PreparationResult>{
  // 재시도는 동일한 명시적 단계만 다시 실행한다. 테스트/병합을 임의로 추가하지 않는다.
  return runPreparationStep(step);
}
